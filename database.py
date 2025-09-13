import sqlite3
from datetime import datetime

class Database:
    def __init__(self, db_path):
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.cursor = self.conn.cursor()
        self.init_tables()
    
    def init_tables(self):
        # جدول کاربران
        self.cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                role TEXT DEFAULT 'member',
                karma INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # جدول ایده‌ها
        self.cursor.execute('''
            CREATE TABLE IF NOT EXISTS ideas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                author_id INTEGER NOT NULL,
                priority TEXT DEFAULT 'medium',
                votes INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (author_id) REFERENCES users (user_id)
            )
        ''')
        
        # جدول تسک‌ها
        self.cursor.execute('''
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                assignee_id INTEGER NOT NULL,
                status TEXT DEFAULT 'ToDo',
                due_date DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (assignee_id) REFERENCES users (user_id)
            )
        ''')
        
        self.conn.commit()
    
    def get_user(self, user_id):
        self.cursor.execute('SELECT * FROM users WHERE user_id = ?', (user_id,))
        return self.cursor.fetchone()
    
    def create_user(self, user_id, username, role='member'):
        if not self.get_user(user_id):
            self.cursor.execute(
                'INSERT INTO users (user_id, username, role) VALUES (?, ?, ?)',
                (user_id, username, role)
            )
            self.conn.commit()
    
    def create_idea(self, title, description, author_id, priority='medium'):
        self.cursor.execute(
            '''INSERT INTO ideas (title, description, author_id, priority) 
               VALUES (?, ?, ?, ?)''',
            (title, description, author_id, priority)
        )
        self.conn.commit()
        
        # افزایش کارما برای کاربر
        self.cursor.execute(
            'UPDATE users SET karma = karma + 10 WHERE user_id = ?',
            (author_id,)
        )
        self.conn.commit()
        return self.cursor.lastrowid
    
    def create_task(self, title, description, assignee_id, due_date):
        self.cursor.execute(
            '''INSERT INTO tasks (title, description, assignee_id, due_date) 
               VALUES (?, ?, ?, ?)''',
            (title, description, assignee_id, due_date)
        )
        self.conn.commit()
        return self.cursor.lastrowid
    
    def get_user_tasks(self, user_id):
        self.cursor.execute('SELECT * FROM tasks WHERE assignee_id = ?', (user_id,))
        return self.cursor.fetchall()
    
    def get_all_ideas(self):
        self.cursor.execute('''
            SELECT ideas.*, users.username 
            FROM ideas 
            JOIN users ON ideas.author_id = users.user_id
            ORDER BY ideas.created_at DESC
        ''')
        return self.cursor.fetchall()
    
    def get_user_karma(self, user_id):
        self.cursor.execute('SELECT karma FROM users WHERE user_id = ?', (user_id,))
        result = self.cursor.fetchone()
        return result[0] if result else 0

    def close(self):
        self.conn.close()