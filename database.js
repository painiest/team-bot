// database.js
// بازنویسی‌شده — اصلاح مدیریت تراکنش‌ها، PRAGMA، و سازگاری با sqlite
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
    constructor(dbPath = path.join(__dirname, 'team_bot.db')) {
        this.dbPath = dbPath;
        this.db = new sqlite3.Database(this.dbPath, (err) => {
            if (err) {
                console.error('Error opening database:', err);
            } else {
                console.log('Connected to SQLite database:', this.dbPath);
                // حتماً PRAGMA رو قبل از ایجاد جداول ست کن
                this.db.serialize(() => {
                    this.db.run("PRAGMA foreign_keys = ON");
                    // WAL improves concurrency (optional)
                    this.db.run("PRAGMA journal_mode = WAL");
                    this.initTables().catch(e => {
                        console.error('initTables error:', e);
                    });
                });
            }
        });
    }

    async initTables() {
        // توجه: SQLite نوع JSON نداره — از TEXT استفاده می‌کنیم و JSON.stringify/parse می‌کنیم
        const tables = [
            `CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                karma INTEGER DEFAULT 0,
                role TEXT DEFAULT 'member',
                last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                accepted_rules INTEGER DEFAULT 0
            )`,

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

            `CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                assignee_id INTEGER,
                assignee_username TEXT,
                deadline TEXT,
                status TEXT DEFAULT 'ToDo',
                creator_id INTEGER,
                related_idea_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (assignee_id) REFERENCES users (user_id) ON DELETE SET NULL,
                FOREIGN KEY (creator_id) REFERENCES users (user_id) ON DELETE SET NULL,
                FOREIGN KEY (related_idea_id) REFERENCES ideas (id) ON DELETE SET NULL
            )`,

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

            `CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uploader_id INTEGER NOT NULL,
                file_id_telegram TEXT NOT NULL,
                title TEXT,
                tags TEXT,
                uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (uploader_id) REFERENCES users (user_id) ON DELETE CASCADE
            )`,

            `CREATE TABLE IF NOT EXISTS polls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                options TEXT NOT NULL, -- JSON stored as TEXT
                votes TEXT DEFAULT '{}' , -- JSON stored as TEXT
                created_by INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users (user_id) ON DELETE CASCADE
            )`,

            `CREATE TABLE IF NOT EXISTS idea_votes (
                user_id INTEGER NOT NULL,
                idea_id INTEGER NOT NULL,
                voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, idea_id),
                FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
                FOREIGN KEY (idea_id) REFERENCES ideas (id) ON DELETE CASCADE
            )`,

            `CREATE TABLE IF NOT EXISTS roles (
                user_id INTEGER PRIMARY KEY,
                role TEXT NOT NULL DEFAULT 'member',
                FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
            )`,

            `CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                type TEXT NOT NULL,
                is_read INTEGER DEFAULT 0,
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

    // ---------- Utility: run/get/all as promises ----------
    run(sql, params = []) {
        const db = this.db;
        return new Promise((resolve, reject) => {
            db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve({ changes: this.changes, lastID: this.lastID });
            });
        });
    }

    get(sql, params = []) {
        const db = this.db;
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    all(sql, params = []) {
        const db = this.db;
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    // ============ USER METHODS ============
    async getUser(userId) {
        return await this.get('SELECT * FROM users WHERE user_id = ?', [userId]);
    }

    async createUser(userId, username = '') {
        const res = await this.run(
            'INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)',
            [userId, username]
        );
        return res.changes > 0;
    }

    async updateUserLastActive(userId) {
        await this.run('UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE user_id = ?', [userId]);
    }

    async acceptRules(userId) {
        await this.run('UPDATE users SET accepted_rules = 1 WHERE user_id = ?', [userId]);
    }

    // ============ IDEA METHODS ============
    createIdea(title, description, authorId, priority = 'medium') {
        const db = this.db;
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION', (err) => {
                    if (err) return reject(err);

                    db.run(
                        'INSERT INTO ideas (title, description, author_id, priority) VALUES (?, ?, ?, ?)',
                        [title, description, authorId, priority],
                        function (err) {
                            if (err) {
                                db.run('ROLLBACK', () => {});
                                return reject(err);
                            }
                            const ideaId = this.lastID;

                            db.run(
                                'UPDATE users SET karma = karma + 10 WHERE user_id = ?',
                                [authorId],
                                (err) => {
                                    if (err) {
                                        db.run('ROLLBACK', () => {});
                                        return reject(err);
                                    }

                                    db.run('COMMIT', (err) => {
                                        if (err) {
                                            db.run('ROLLBACK', () => {});
                                            return reject(err);
                                        }
                                        resolve(ideaId);
                                    });
                                }
                            );
                        }
                    );
                });
            });
        });
    }

    voteForIdea(userId, ideaId) {
        const db = this.db;
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION', (err) => {
                    if (err) return reject(err);

                    db.get(
                        'SELECT 1 FROM idea_votes WHERE user_id = ? AND idea_id = ?',
                        [userId, ideaId],
                        (err, row) => {
                            if (err) {
                                db.run('ROLLBACK', () => {});
                                return reject(err);
                            }

                            if (row) {
                                db.run('ROLLBACK', () => {});
                                return resolve(false); // already voted
                            }

                            db.run(
                                'INSERT INTO idea_votes (user_id, idea_id) VALUES (?, ?)',
                                [userId, ideaId],
                                function (err) {
                                    if (err) {
                                        db.run('ROLLBACK', () => {});
                                        return reject(err);
                                    }

                                    db.run(
                                        'UPDATE ideas SET votes = votes + 1 WHERE id = ?',
                                        [ideaId],
                                        (err) => {
                                            if (err) {
                                                db.run('ROLLBACK', () => {});
                                                return reject(err);
                                            }

                                            db.run('COMMIT', (err) => {
                                                if (err) {
                                                    db.run('ROLLBACK', () => {});
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
        });
    }

    getAllIdeas(limit = 50, offset = 0) {
        const sql = `
            SELECT ideas.*, users.username,
            (SELECT COUNT(*) FROM idea_votes WHERE idea_votes.idea_id = ideas.id) as vote_count
            FROM ideas
            LEFT JOIN users ON ideas.author_id = users.user_id
            ORDER BY ideas.created_at DESC
            LIMIT ? OFFSET ?
        `;
        return this.all(sql, [limit, offset]);
    }

    // ============ TASK METHODS ============
    createTask(title, description, assigneeId, assigneeUsername, deadline, status, creatorId, relatedIdeaId = null) {
        const db = this.db;
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION', (err) => {
                    if (err) return reject(err);

                    db.run(
                        `INSERT INTO tasks 
                         (title, description, assignee_id, assignee_username, deadline, status, creator_id, related_idea_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [title, description, assigneeId, assigneeUsername, deadline, status, creatorId, relatedIdeaId],
                        function (err) {
                            if (err) {
                                db.run('ROLLBACK', () => {});
                                return reject(err);
                            }
                            const taskId = this.lastID;

                            db.run(
                                'UPDATE users SET karma = karma + 5 WHERE user_id = ?',
                                [creatorId],
                                (err) => {
                                    if (err) {
                                        db.run('ROLLBACK', () => {});
                                        return reject(err);
                                    }

                                    db.run('COMMIT', (err) => {
                                        if (err) {
                                            db.run('ROLLBACK', () => {});
                                            return reject(err);
                                        }
                                        resolve(taskId);
                                    });
                                }
                            );
                        }
                    );
                });
            });
        });
    }

    updateTaskStatus(taskId, newStatus) {
        const db = this.db;
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION', (err) => {
                    if (err) return reject(err);

                    db.run('UPDATE tasks SET status = ? WHERE id = ?', [newStatus, taskId], function (err) {
                        if (err) {
                            db.run('ROLLBACK', () => {});
                            return reject(err);
                        }

                        const changes = this.changes;

                        if (String(newStatus).toLowerCase() === 'done') {
                            db.get('SELECT assignee_id FROM tasks WHERE id = ?', [taskId], (err, task) => {
                                if (err) {
                                    db.run('ROLLBACK', () => {});
                                    return reject(err);
                                }

                                if (task && task.assignee_id) {
                                    db.run('UPDATE users SET karma = karma + 30 WHERE user_id = ?', [task.assignee_id], (err) => {
                                        if (err) {
                                            db.run('ROLLBACK', () => {});
                                            return reject(err);
                                        }

                                        db.run('COMMIT', (err) => {
                                            if (err) {
                                                db.run('ROLLBACK', () => {});
                                                return reject(err);
                                            }
                                            resolve(changes > 0);
                                        });
                                    });
                                } else {
                                    db.run('COMMIT', (err) => {
                                        if (err) {
                                            db.run('ROLLBACK', () => {});
                                            return reject(err);
                                        }
                                        resolve(changes > 0);
                                    });
                                }
                            });
                        } else {
                            db.run('COMMIT', (err) => {
                                if (err) {
                                    db.run('ROLLBACK', () => {});
                                    return reject(err);
                                }
                                resolve(changes > 0);
                            });
                        }
                    });
                });
            });
        });
    }

    getUserTasks(userId) {
        const sql = `
            SELECT tasks.*,
            (SELECT username FROM users WHERE user_id = tasks.creator_id) as creator_username
            FROM tasks
            WHERE assignee_id = ?
            ORDER BY created_at DESC
        `;
        return this.all(sql, [userId]);
    }

    getOverdueTasks() {
        return this.all(
            `SELECT * FROM tasks 
             WHERE deadline < date('now') AND status NOT IN ('Done', 'Overdue')`
        );
    }

    // ============ STANDUP METHODS ============
    createStandup(userId, date, yesterday, today, blocker) {
        return this.run(
            'INSERT OR REPLACE INTO standups (user_id, date, yesterday, today, blocker) VALUES (?, ?, ?, ?, ?)',
            [userId, date, yesterday, today, blocker]
        ).then(res => res.changes > 0);
    }

    getTodaysStandups() {
        const today = new Date().toISOString().split('T')[0];
        const sql = `
            SELECT standups.*, users.username
            FROM standups
            JOIN users ON standups.user_id = users.user_id
            WHERE date = ?
        `;
        return this.all(sql, [today]);
    }

    getUsersWithoutStandup(days = 3) {
        const sql = `
            SELECT user_id, username
            FROM users
            WHERE user_id NOT IN (
                SELECT DISTINCT user_id FROM standups WHERE date >= date('now', ?)
            ) AND role != 'inactive'
        `;
        return this.all(sql, [`-${days} days`]);
    }

    // ============ FILE METHODS ============
    saveFile(uploaderId, fileId, title = '', tags = '') {
        return this.run(
            'INSERT INTO files (uploader_id, file_id_telegram, title, tags) VALUES (?, ?, ?, ?)',
            [uploaderId, fileId, title, tags]
        ).then(res => res.lastID);
    }

    getFilesByTag(tag, limit = 20) {
        const sql = `
            SELECT files.*, users.username
            FROM files
            JOIN users ON files.uploader_id = users.user_id
            WHERE tags LIKE ?
            ORDER BY uploaded_at DESC
            LIMIT ?
        `;
        return this.all(sql, [`%${tag}%`, limit]);
    }

    // ============ POLL METHODS ============
    createPoll(title, options = [], createdBy) {
        const sql = 'INSERT INTO polls (title, options, created_by) VALUES (?, ?, ?)';
        return this.run(sql, [title, JSON.stringify(options), createdBy]).then(res => res.lastID);
    }

    voteInPoll(pollId, userId, optionIndex) {
        const db = this.db;
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION', (err) => {
                    if (err) return reject(err);

                    db.get('SELECT votes FROM polls WHERE id = ?', [pollId], (err, row) => {
                        if (err) {
                            db.run('ROLLBACK', () => {});
                            return reject(err);
                        }

                        let votes = {};
                        try {
                            votes = row && row.votes ? JSON.parse(row.votes) : {};
                        } catch (e) {
                            votes = {};
                        }

                        const userVoteKey = `user_${userId}`;
                        // replace previous vote
                        votes[userVoteKey] = optionIndex;

                        db.run('UPDATE polls SET votes = ? WHERE id = ?', [JSON.stringify(votes), pollId], (err) => {
                            if (err) {
                                db.run('ROLLBACK', () => {});
                                return reject(err);
                            }

                            db.run('COMMIT', (err) => {
                                if (err) {
                                    db.run('ROLLBACK', () => {});
                                    return reject(err);
                                }
                                resolve(true);
                            });
                        });
                    });
                });
            });
        });
    }

    getPollResults(pollId) {
        const sql = `
            SELECT polls.*, users.username as creator_name
            FROM polls
            JOIN users ON polls.created_by = users.user_id
            WHERE polls.id = ?
        `;
        return this.get(sql, [pollId]).then(row => {
            if (!row) return null;
            // parse options & votes
            try { row.options = JSON.parse(row.options); } catch (e) { row.options = []; }
            try { row.votes = JSON.parse(row.votes || '{}'); } catch (e) { row.votes = {}; }
            return row;
        });
    }

    // ============ ROLE & PERMISSION METHODS ============
    setUserRole(userId, role) {
        return this.run('INSERT OR REPLACE INTO roles (user_id, role) VALUES (?, ?)', [userId, role]).then(r => r.changes > 0);
    }

    async getUserRole(userId) {
        const row = await this.get('SELECT role FROM roles WHERE user_id = ?', [userId]);
        return row ? row.role : 'member';
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
        return this.run('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)', [userId, message, type]).then(r => r.lastID);
    }

    getUnreadNotifications(userId) {
        return this.all('SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC', [userId]);
    }

    markNotificationAsRead(notificationId) {
        return this.run('UPDATE notifications SET is_read = 1 WHERE id = ?', [notificationId]).then(r => r.changes > 0);
    }

    // ============ KARMA & STATS METHODS ============
    getUserKarma(userId) {
        return this.get('SELECT karma FROM users WHERE user_id = ?', [userId]).then(row => row ? row.karma : 0);
    }

    addKarma(userId, amount) {
        return this.run('UPDATE users SET karma = karma + ? WHERE user_id = ?', [amount, userId]);
    }

    getTopUsersByKarma(limit = 10) {
        return this.all('SELECT user_id, username, karma FROM users ORDER BY karma DESC LIMIT ?', [limit]);
    }

    getDashboardStats() {
        const sql = `
            SELECT 
             (SELECT COUNT(*) FROM users) as total_users,
             (SELECT COUNT(*) FROM ideas) as total_ideas,
             (SELECT COUNT(*) FROM tasks WHERE status = 'Done') as completed_tasks,
             (SELECT COUNT(*) FROM tasks) as total_tasks,
             (SELECT COUNT(*) FROM users WHERE last_active >= date('now', '-7 days')) as active_users
        `;
        return this.get(sql, []);
    }

    // ============ SEARCH & UTIL ============
    getUserByUsername(username) {
        return this.get('SELECT * FROM users WHERE username = ?', [username]);
    }

    searchContent(query, type = 'all') {
        const q = `%${query}%`;
        if (type === 'ideas') {
            return this.all(`SELECT 'idea' as type, id, title, description, created_at FROM ideas WHERE title LIKE ? OR description LIKE ? ORDER BY created_at DESC`, [q, q]);
        } else if (type === 'tasks') {
            return this.all(`SELECT 'task' as type, id, title, description, created_at FROM tasks WHERE title LIKE ? OR description LIKE ? ORDER BY created_at DESC`, [q, q]);
        } else if (type === 'files') {
            return this.all(`SELECT 'file' as type, id, title, tags as description, uploaded_at as created_at FROM files WHERE title LIKE ? OR tags LIKE ? ORDER BY uploaded_at DESC`, [q, q]);
        } else {
            const sql = `
                SELECT 'idea' as type, id, title, description, created_at FROM ideas WHERE title LIKE ? OR description LIKE ?
                UNION
                SELECT 'task' as type, id, title, description, created_at FROM tasks WHERE title LIKE ? OR description LIKE ?
                UNION
                SELECT 'file' as type, id, title, tags as description, uploaded_at as created_at FROM files WHERE title LIKE ? OR tags LIKE ?
                ORDER BY created_at DESC
                LIMIT 20
            `;
            return this.all(sql, [q, q, q, q, q, q]);
        }
    }

    close() {
        if (!this.db) return;
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
