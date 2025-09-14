const sqlite3 = require('sqlite3').verbose();

class Database {
    constructor(dbPath = 'team_bot.db') {
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Error opening database:', err);
            } else {
                console.log('Connected to SQLite database');
                this.initTables();
                this.enableForeignKeys();
            }
        });
    }

    enableForeignKeys() {
        this.db.run('PRAGMA foreign_keys = ON');
    }

    async initTables() {
        const tables = [
            // Users table
            `CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                karma INTEGER DEFAULT 0,
                role TEXT DEFAULT 'member',
                last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                accepted_rules BOOLEAN DEFAULT FALSE
            )`,

            // Ideas table
            `CREATE TABLE IF NOT EXISTS ideas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                author_id INTEGER NOT NULL,
                priority TEXT DEFAULT 'medium',
                votes INTEGER DEFAULT 0,
                status TEXT DEFAULT 'open',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (author_id) REFERENCES users (user_id) ON DELETE CASCADE
            )`,

            // Tasks table
            `CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                assignee_username TEXT NOT NULL,
                deadline TEXT,
                status TEXT DEFAULT 'ToDo',
                creator_id INTEGER NOT NULL,
                related_idea_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (creator_id) REFERENCES users (user_id) ON DELETE CASCADE,
                FOREIGN KEY (related_idea_id) REFERENCES ideas (id) ON DELETE SET NULL
            )`,

            // Standups table
            `CREATE TABLE IF NOT EXISTS standups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                date TEXT NOT NULL,
                yesterday TEXT,
                today TEXT,
                blocker TEXT,
                submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
                UNIQUE(user_id, date)
            )`,

            // Files table
            `CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uploader_id INTEGER NOT NULL,
                file_id_telegram TEXT NOT NULL,
                title TEXT,
                tags TEXT,
                uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (uploader_id) REFERENCES users (user_id) ON DELETE CASCADE
            )`,

            // Polls table
            `CREATE TABLE IF NOT EXISTS polls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                options JSON NOT NULL,
                votes JSON DEFAULT '{}',
                created_by INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users (user_id) ON DELETE CASCADE
            )`,

            // Idea Votes table (برای جلوگیری از رأی تکراری)
            `CREATE TABLE IF NOT EXISTS idea_votes (
                user_id INTEGER NOT NULL,
                idea_id INTEGER NOT NULL,
                voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, idea_id),
                FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
                FOREIGN KEY (idea_id) REFERENCES ideas (id) ON DELETE CASCADE
            )`,

            // Roles table (برای مدیریت نقش‌ها)
            `CREATE TABLE IF NOT EXISTS roles (
                user_id INTEGER PRIMARY KEY,
                role TEXT NOT NULL DEFAULT 'member',
                FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
            )`,

            // Notifications table (برای اعلان‌های هوشمند)
            `CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                type TEXT NOT NULL,
                is_read BOOLEAN DEFAULT FALSE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
            )`
        ];

        for (const sql of tables) {
            await new Promise((resolve, reject) => {
                this.db.run(sql, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
        console.log('All tables initialized successfully');
    }

    // ============ USER METHODS ============
    getUser(userId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    createUser(userId, username = '') {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)',
                [userId, username],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes > 0);
                }
            );
        });
    }

    updateUserLastActive(userId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE user_id = ?',
                [userId],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    acceptRules(userId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET accepted_rules = TRUE WHERE user_id = ?',
                [userId],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    // ============ IDEA METHODS ============
    createIdea(title, description, authorId, priority = 'medium') {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');

                this.db.run(
                    'INSERT INTO ideas (title, description, author_id, priority) VALUES (?, ?, ?, ?)',
                    [title, description, authorId, priority],
                    function(err) {
                        if (err) {
                            this.db.run('ROLLBACK');
                            return reject(err);
                        }
                        const ideaId = this.lastID;

                        // Add karma to author
                        this.db.run(
                            'UPDATE users SET karma = karma + 10 WHERE user_id = ?',
                            [authorId],
                            (err) => {
                                if (err) {
                                    this.db.run('ROLLBACK');
                                    return reject(err);
                                }

                                this.db.run('COMMIT', (err) => {
                                    if (err) {
                                        this.db.run('ROLLBACK');
                                        return reject(err);
                                    }
                                    resolve(ideaId);
                                });
                            }
                        );
                    }.bind(this)
                );
            });
        });
    }

    voteForIdea(userId, ideaId) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');

                // Check if already voted
                this.db.get(
                    'SELECT 1 FROM idea_votes WHERE user_id = ? AND idea_id = ?',
                    [userId, ideaId],
                    (err, row) => {
                        if (err) {
                            this.db.run('ROLLBACK');
                            return reject(err);
                        }

                        if (row) {
                            this.db.run('ROLLBACK');
                            return resolve(false); // Already voted
                        }

                        // Insert vote record
                        this.db.run(
                            'INSERT INTO idea_votes (user_id, idea_id) VALUES (?, ?)',
                            [userId, ideaId],
                            (err) => {
                                if (err) {
                                    this.db.run('ROLLBACK');
                                    return reject(err);
                                }

                                // Update idea votes count
                                this.db.run(
                                    'UPDATE ideas SET votes = votes + 1 WHERE id = ?',
                                    [ideaId],
                                    (err) => {
                                        if (err) {
                                            this.db.run('ROLLBACK');
                                            return reject(err);
                                        }

                                        this.db.run('COMMIT', (err) => {
                                            if (err) {
                                                this.db.run('ROLLBACK');
                                                return reject(err);
                                            }
                                            resolve(true);
                                        });
                                    }
                                );
                            }
                        );
                    }
                );
            });
        });
    }

    getAllIdeas(limit = 50, offset = 0) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT ideas.*, users.username, 
                 (SELECT COUNT(*) FROM idea_votes WHERE idea_votes.idea_id = ideas.id) as vote_count
                 FROM ideas 
                 LEFT JOIN users ON ideas.author_id = users.user_id 
                 ORDER BY ideas.created_at DESC 
                 LIMIT ? OFFSET ?`,
                [limit, offset],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    // ============ TASK METHODS ============
    createTask(title, description, assignee, deadline, status, creatorId, relatedIdeaId = null) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');

                this.db.run(
                    'INSERT INTO tasks (title, description, assignee_username, deadline, status, creator_id, related_idea_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [title, description, assignee, deadline, status, creatorId, relatedIdeaId],
                    function(err) {
                        if (err) {
                            this.db.run('ROLLBACK');
                            return reject(err);
                        }
                        const taskId = this.lastID;

                        // Add karma to creator
                        this.db.run(
                            'UPDATE users SET karma = karma + 5 WHERE user_id = ?',
                            [creatorId],
                            (err) => {
                                if (err) {
                                    this.db.run('ROLLBACK');
                                    return reject(err);
                                }

                                this.db.run('COMMIT', (err) => {
                                    if (err) {
                                        this.db.run('ROLLBACK');
                                        return reject(err);
                                    }
                                    resolve(taskId);
                                });
                            }
                        );
                    }.bind(this)
                );
            });
        });
    }

    updateTaskStatus(taskId, newStatus) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');

                this.db.run(
                    'UPDATE tasks SET status = ? WHERE id = ?',
                    [newStatus, taskId],
                    function(err) {
                        if (err) {
                            this.db.run('ROLLBACK');
                            return reject(err);
                        }

                        // If task is marked as done, add karma to assignee
                        if (newStatus.toLowerCase() === 'done') {
                            this.db.get(
                                'SELECT assignee_username FROM tasks WHERE id = ?',
                                [taskId],
                                (err, task) => {
                                    if (err) {
                                        this.db.run('ROLLBACK');
                                        return reject(err);
                                    }

                                    if (task && task.assignee_username) {
                                        this.db.get(
                                            'SELECT user_id FROM users WHERE username = ?',
                                            [task.assignee_username],
                                            (err, user) => {
                                                if (err) {
                                                    this.db.run('ROLLBACK');
                                                    return reject(err);
                                                }

                                                if (user) {
                                                    this.db.run(
                                                        'UPDATE users SET karma = karma + 30 WHERE user_id = ?',
                                                        [user.user_id],
                                                        (err) => {
                                                            if (err) {
                                                                this.db.run('ROLLBACK');
                                                                return reject(err);
                                                            }

                                                            this.db.run('COMMIT', (err) => {
                                                                if (err) {
                                                                    this.db.run('ROLLBACK');
                                                                    return reject(err);
                                                                }
                                                                resolve(this.changes > 0);
                                                            });
                                                        }
                                                    );
                                                } else {
                                                    this.db.run('COMMIT', (err) => {
                                                        if (err) {
                                                            this.db.run('ROLLBACK');
                                                            return reject(err);
                                                        }
                                                        resolve(this.changes > 0);
                                                    });
                                                }
                                            }
                                        );
                                    } else {
                                        this.db.run('COMMIT', (err) => {
                                            if (err) {
                                                this.db.run('ROLLBACK');
                                                return reject(err);
                                            }
                                            resolve(this.changes > 0);
                                        });
                                    }
                                }
                            );
                        } else {
                            this.db.run('COMMIT', (err) => {
                                if (err) {
                                    this.db.run('ROLLBACK');
                                    return reject(err);
                                }
                                resolve(this.changes > 0);
                            });
                        }
                    }.bind(this)
                );
            });
        });
    }

    getUserTasks(userId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT tasks.*, 
                 (SELECT username FROM users WHERE user_id = tasks.creator_id) as creator_username
                 FROM tasks 
                 WHERE assignee_username = COALESCE((SELECT username FROM users WHERE user_id = ?), '') 
                 ORDER BY created_at DESC`,
                [userId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    getOverdueTasks() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT tasks.*, users.user_id as assignee_id
                 FROM tasks 
                 LEFT JOIN users ON tasks.assignee_username = users.username
                 WHERE deadline < date('now') AND status NOT IN ('Done', 'Overdue')`,
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    // ============ STANDUP METHODS ============
    createStandup(userId, date, yesterday, today, blocker) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR REPLACE INTO standups (user_id, date, yesterday, today, blocker) VALUES (?, ?, ?, ?, ?)',
                [userId, date, yesterday, today, blocker],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes > 0);
                }
            );
        });
    }

    getTodaysStandups() {
        const today = new Date().toISOString().split('T')[0];
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT standups.*, users.username 
                 FROM standups 
                 JOIN users ON standups.user_id = users.user_id 
                 WHERE date = ?`,
                [today],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    getUsersWithoutStandup(days = 3) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT user_id, username 
                 FROM users 
                 WHERE user_id NOT IN (
                     SELECT DISTINCT user_id 
                     FROM standups 
                     WHERE date >= date('now', ?)
                 ) AND role != 'inactive'`,
                [`-${days} days`],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    // ============ FILE METHODS ============
    saveFile(uploaderId, fileId, title = '', tags = '') {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO files (uploader_id, file_id_telegram, title, tags) VALUES (?, ?, ?, ?)',
                [uploaderId, fileId, title, tags],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    getFilesByTag(tag, limit = 20) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT files.*, users.username 
                 FROM files 
                 JOIN users ON files.uploader_id = users.user_id 
                 WHERE tags LIKE ? 
                 ORDER BY uploaded_at DESC 
                 LIMIT ?`,
                [`%${tag}%`, limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    // ============ POLL METHODS ============
    createPoll(title, options, createdBy) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO polls (title, options, created_by) VALUES (?, ?, ?)',
                [title, JSON.stringify(options), createdBy],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    voteInPoll(pollId, userId, optionIndex) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');

                // Get current votes
                this.db.get(
                    'SELECT votes FROM polls WHERE id = ?',
                    [pollId],
                    (err, row) => {
                        if (err) {
                            this.db.run('ROLLBACK');
                            return reject(err);
                        }

                        let votes = row.votes ? JSON.parse(row.votes) : {};
                        const userVoteKey = `user_${userId}`;

                        // Remove previous vote if exists
                        if (votes[userVoteKey] !== undefined) {
                            delete votes[userVoteKey];
                        }

                        // Add new vote
                        votes[userVoteKey] = optionIndex;

                        // Update poll
                        this.db.run(
                            'UPDATE polls SET votes = ? WHERE id = ?',
                            [JSON.stringify(votes), pollId],
                            (err) => {
                                if (err) {
                                    this.db.run('ROLLBACK');
                                    return reject(err);
                                }

                                this.db.run('COMMIT', (err) => {
                                    if (err) {
                                        this.db.run('ROLLBACK');
                                        return reject(err);
                                    }
                                    resolve(true);
                                });
                            }
                        );
                    }
                );
            });
        });
    }

    getPollResults(pollId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT polls.*, users.username as creator_name 
                 FROM polls 
                 JOIN users ON polls.created_by = users.user_id 
                 WHERE polls.id = ?`,
                [pollId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    // ============ ROLE & PERMISSION METHODS ============
    setUserRole(userId, role) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR REPLACE INTO roles (user_id, role) VALUES (?, ?)',
                [userId, role],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes > 0);
                }
            );
        });
    }

    getUserRole(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT role FROM roles WHERE user_id = ?',
                [userId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.role : 'member');
                }
            );
        });
    }

    isAdmin(userId) {
        return new Promise(async (resolve, reject) => {
            try {
                const role = await this.getUserRole(userId);
                resolve(['admin', 'owner'].includes(role));
            } catch (error) {
                reject(error);
            }
        });
    }

    // ============ NOTIFICATION METHODS ============
    createNotification(userId, message, type = 'info') {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)',
                [userId, message, type],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    getUnreadNotifications(userId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM notifications WHERE user_id = ? AND is_read = FALSE ORDER BY created_at DESC',
                [userId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    markNotificationAsRead(notificationId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE notifications SET is_read = TRUE WHERE id = ?',
                [notificationId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes > 0);
                }
            );
        });
    }

    // ============ KARMA & STATS METHODS ============
    getUserKarma(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT karma FROM users WHERE user_id = ?',
                [userId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.karma : 0);
                }
            );
        });
    }

    addKarma(userId, amount) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET karma = karma + ? WHERE user_id = ?',
                [amount, userId],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    getTopUsersByKarma(limit = 10) {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT user_id, username, karma FROM users ORDER BY karma DESC LIMIT ?',
                [limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    getDashboardStats() {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT 
                 (SELECT COUNT(*) FROM users) as total_users,
                 (SELECT COUNT(*) FROM ideas) as total_ideas,
                 (SELECT COUNT(*) FROM tasks WHERE status = 'Done') as completed_tasks,
                 (SELECT COUNT(*) FROM tasks) as total_tasks,
                 (SELECT COUNT(*) FROM users WHERE last_active >= date('now', '-7 days')) as active_users`,
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    // ============ UTILITY METHODS ============
    getUserByUsername(username) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    getUser(userId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    searchContent(query, type = 'all') {
        return new Promise((resolve, reject) => {
            let sql = '';
            let params = [`%${query}%`];

            switch (type) {
                case 'ideas':
                    sql = `SELECT 'idea' as type, id, title, description, created_at 
                           FROM ideas 
                           WHERE title LIKE ? OR description LIKE ? 
                           ORDER BY created_at DESC`;
                    params = [params[0], params[0]];
                    break;
                case 'tasks':
                    sql = `SELECT 'task' as type, id, title, description, created_at 
                           FROM tasks 
                           WHERE title LIKE ? OR description LIKE ? 
                           ORDER BY created_at DESC`;
                    params = [params[0], params[0]];
                    break;
                case 'files':
                    sql = `SELECT 'file' as type, id, title, tags as description, uploaded_at as created_at 
                           FROM files 
                           WHERE title LIKE ? OR tags LIKE ? 
                           ORDER BY uploaded_at DESC`;
                    params = [params[0], params[0]];
                    break;
                default:
                    sql = `SELECT 'idea' as type, id, title, description, created_at 
                           FROM ideas 
                           WHERE title LIKE ? OR description LIKE ? 
                           UNION
                           SELECT 'task' as type, id, title, description, created_at 
                           FROM tasks 
                           WHERE title LIKE ? OR description LIKE ? 
                           UNION
                           SELECT 'file' as type, id, title, tags as description, uploaded_at as created_at 
                           FROM files 
                           WHERE title LIKE ? OR tags LIKE ? 
                           ORDER BY created_at DESC 
                           LIMIT 20`;
                    params = [params[0], params[0], params[0], params[0], params[0], params[0]];
            }

            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    close() {
        this.db.close((err) => {
            if (err) {
                console.error('Error closing database:', err);
            } else {
                console.log('Database connection closed');
            }
        });
    }
}

module.exports = Database;