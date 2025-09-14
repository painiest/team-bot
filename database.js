const sqlite3 = require('sqlite3').verbose();

class Database {
    constructor(dbPath = 'team_bot.db') {
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Error opening database:', err);
            } else {
                console.log('Connected to SQLite database');
                this.initTables();
            }
        });
    }

    async initTables() {
        const tables = [
            `CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                karma INTEGER DEFAULT 0
            )`,
            `CREATE TABLE IF NOT EXISTS ideas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                author_id INTEGER NOT NULL,
                priority TEXT DEFAULT 'medium',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                assignee_username TEXT NOT NULL,
                deadline TEXT,
                status TEXT DEFAULT 'ToDo',
                creator_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        console.log('Tables initialized');
    }

    getUser(userId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    createUser(userId, username = '') {  // Fallback to empty string
        return new Promise((resolve, reject) => {
            // Idempotent: INSERT OR IGNORE to avoid UNIQUE violation
            this.db.run(
                'INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)',
                [userId, username],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes > 0 ? this.lastID : null);  // 1 if inserted, 0 if ignored
                }
            );
        });
    }

    createIdea(title, description, authorId, priority = 'medium') {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {  // Transaction-like
                this.db.run(
                    'BEGIN TRANSACTION',
                    (err) => {
                        if (err) return reject(err);
                        this.db.run(
                            'INSERT INTO ideas (title, description, author_id, priority) VALUES (?, ?, ?, ?)',
                            [title, description, authorId, priority],
                            function(err) {
                                if (err) {
                                    this.db.run('ROLLBACK');
                                    return reject(err);
                                }
                                // Add karma only if user exists
                                this.db.get('SELECT user_id FROM users WHERE user_id = ?', [authorId], (err, user) => {
                                    if (err) {
                                        this.db.run('ROLLBACK');
                                        reject(err);
                                    } else if (user) {
                                        this.db.run(
                                            'UPDATE users SET karma = karma + 10 WHERE user_id = ?',
                                            [authorId],
                                            (err) => {
                                                if (err) {
                                                    this.db.run('ROLLBACK');
                                                    reject(err);
                                                } else {
                                                    this.db.run('COMMIT', () => resolve(this.lastID));
                                                }
                                            }
                                        );
                                    } else {
                                        this.db.run('ROLLBACK');
                                        reject(new Error('User not found for karma update'));
                                    }
                                });
                            }.bind(this)
                        );
                    }
                );
            });
        });
    }

    createTask(title, description, assignee, deadline, status, creatorId) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run(
                    'BEGIN TRANSACTION',
                    (err) => {
                        if (err) return reject(err);
                        this.db.run(
                            'INSERT INTO tasks (title, description, assignee_username, deadline, status, creator_id) VALUES (?, ?, ?, ?, ?, ?)',
                            [title, description, assignee, deadline, status, creatorId],
                            function(err) {
                                if (err) {
                                    this.db.run('ROLLBACK');
                                    return reject(err);
                                }
                                // Add karma to creator
                                this.db.run(
                                    'UPDATE users SET karma = karma + 5 WHERE user_id = ?',
                                    [creatorId],
                                    (err) => {
                                        if (err) {
                                            this.db.run('ROLLBACK');
                                            reject(err);
                                        } else {
                                            this.db.run('COMMIT', () => resolve(this.lastID));
                                        }
                                    }
                                );
                            }.bind(this)
                        );
                    }
                );
            });
        });
    }

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

    getAllIdeas() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT ideas.*, COALESCE(users.username, 'ناشناس') as username 
                 FROM ideas 
                 LEFT JOIN users ON ideas.author_id = users.user_id 
                 ORDER BY ideas.created_at DESC`,
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    getUserByUsername(username) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    getUserTasks(userId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM tasks 
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

    close() {
        this.db.close();
    }
}

module.exports = Database;