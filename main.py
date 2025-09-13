import os
import logging
import sqlite3
from datetime import datetime

# تنظیمات محیطی
BOT_TOKEN = os.getenv('BOT_TOKEN', 'YOUR_BOT_TOKEN_HERE')
ADMIN_USER_IDS = [6155502698]  # جایگزین کنید با آیدی خودتان
GROUP_CHAT_ID = -1003026552272  # جایگزین کنید با آیدی گروه خودتان
DB_PATH = 'team_bot.db'

# تنظیمات لاگینگ
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# کلاس دیتابیس
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

# ایجاد نمونه دیتابیس
db = Database(DB_PATH)

# بخش اصلی ربات
from telegram import Update, ReplyKeyboardMarkup, ReplyKeyboardRemove
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    ConversationHandler, CallbackContext, filters
)

# حالت‌های مکالمه برای ثبت ایده و تسک
IDEA_TITLE, IDEA_DESCRIPTION, IDEA_PRIORITY = range(3)
TASK_TITLE, TASK_DESCRIPTION, TASK_ASSIGNEE, TASK_DUE = range(4)

async def start(update: Update, context: CallbackContext):
    user = update.effective_user
    db.create_user(user.id, user.username)
    
    welcome_message = (
        f"سلام {user.first_name}! 👋\n"
        "به ربات مدیریت تیم خوش اومدی!\n\n"
        "📝 /idea - ثبت ایده جدید\n"
        "✅ /task - ایجاد تسک جدید\n"
        "📋 /mytasks - مشاهده تسک‌های من\n"
        "💡 /ideas - مشاهده ایده‌ها\n"
        "🏆 /karma - امتیاز من"
    )
    
    await update.message.reply_text(welcome_message)

async def idea_start(update: Update, context: CallbackContext):
    await update.message.reply_text(
        "عالی! می‌خوای یک ایده جدید ثبت کنی.\nلطفاً عنوان ایده رو وارد کن:",
        reply_markup=ReplyKeyboardRemove()
    )
    return IDEA_TITLE

async def idea_title(update: Update, context: CallbackContext):
    context.user_data['idea_title'] = update.message.text
    await update.message.reply_text("خوبه! حالا یک توضیح کوتاه برای ایده ات بنویس:")
    return IDEA_DESCRIPTION

async def idea_description(update: Update, context: CallbackContext):
    context.user_data['idea_description'] = update.message.text
    
    # ایجاد کیبورد برای انتخاب اولویت
    keyboard = [['کم', 'متوسط', 'زیاد']]
    reply_markup = ReplyKeyboardMarkup(keyboard, one_time_keyboard=True)
    
    await update.message.reply_text(
        "اولویت ایده رو انتخاب کن:",
        reply_markup=reply_markup
    )
    return IDEA_PRIORITY

async def idea_priority(update: Update, context: CallbackContext):
    priority = update.message.text
    user = update.effective_user
    
    # ذخیره ایده در دیتابیس
    idea_id = db.create_idea(
        context.user_data['idea_title'],
        context.user_data['idea_description'],
        user.id,
        priority
    )
    
    # ارسال ایده به گروه
    idea_message = (
        f"💡 ایده جدید!\n\n"
        f"عنوان: {context.user_data['idea_title']}\n"
        f"توضیح: {context.user_data['idea_description']}\n"
        f"اولویت: {priority}\n"
        f"ثبت شده توسط: @{user.username if user.username else user.first_name}"
    )
    
    try:
        await context.bot.send_message(GROUP_CHAT_ID, idea_message)
    except Exception as e:
        logger.error(f"Error sending message to group: {e}")
    
    # پاک کردن داده‌های موقت
    context.user_data.clear()
    
    await update.message.reply_text(
        "ایده تو با موفقیت ثبت شد! 🎉\n10 امتیاز کارما گرفتی!",
        reply_markup=ReplyKeyboardRemove()
    )
    
    return ConversationHandler.END

async def task_start(update: Update, context: CallbackContext):
    await update.message.reply_text(
        "برای ایجاد تسک جدید، لطفاً عنوان تسک رو وارد کن:",
        reply_markup=ReplyKeyboardRemove()
    )
    return TASK_TITLE

async def task_title(update: Update, context: CallbackContext):
    context.user_data['task_title'] = update.message.text
    await update.message.reply_text("توضیح تسک رو بنویس:")
    return TASK_DESCRIPTION

async def task_description(update: Update, context: CallbackContext):
    context.user_data['task_description'] = update.message.text
    await update.message.reply_text("آیدی عددی کاربری که میخوای تسک رو分配给 بده رو وارد کن:")
    return TASK_ASSIGNEE

async def task_assignee(update: Update, context: CallbackContext):
    try:
        assignee_id = int(update.message.text)
        context.user_data['task_assignee'] = assignee_id
        await update.message.reply_text("تاریخ مهلت تسک رو به فرمت YYYY-MM-DD وارد کن (مثلاً 2024-12-31):")
        return TASK_DUE
    except ValueError:
        await update.message.reply_text("لطفاً یک آیدی عددی معتبر وارد کن:")
        return TASK_ASSIGNEE

async def task_due(update: Update, context: CallbackContext):
    due_date = update.message.text
    user = update.effective_user
    
    # ذخیره تسک در دیتابیس
    task_id = db.create_task(
        context.user_data['task_title'],
        context.user_data['task_description'],
        context.user_data['task_assignee'],
        due_date
    )
    
    # پاک کردن داده‌های موقت
    context.user_data.clear()
    
    await update.message.reply_text(
        "تسک با موفقیت ایجاد شد! ✅",
        reply_markup=ReplyKeyboardRemove()
    )
    
    return ConversationHandler.END

async def my_tasks(update: Update, context: CallbackContext):
    user = update.effective_user
    tasks = db.get_user_tasks(user.id)
    
    if not tasks:
        await update.message.reply_text("هیچ تسکی分配给 تو نشده.")
        return
    
    tasks_list = "📋 تسک‌های شما:\n\n"
    for task in tasks:
        tasks_list += f"• {task[1]} - وضعیت: {task[4]}\n"
    
    await update.message.reply_text(tasks_list)

async def show_ideas(update: Update, context: CallbackContext):
    ideas = db.get_all_ideas()
    
    if not ideas:
        await update.message.reply_text("هنوز هیچ ایده‌ای ثبت نشده.")
        return
    
    ideas_list = "💡 ایده‌های ثبت شده:\n\n"
    for idea in ideas:
        ideas_list += f"• {idea[1]} - توسط: {idea[7]} - اولویت: {idea[4]}\n"
    
    # اگر لیست طولانی باشد، آن را به چند پیام تقسیم می‌کنیم
    if len(ideas_list) > 4096:
        for x in range(0, len(ideas_list), 4096):
            await update.message.reply_text(ideas_list[x:x+4096])
    else:
        await update.message.reply_text(ideas_list)

async def show_karma(update: Update, context: CallbackContext):
    user = update.effective_user
    karma = db.get_user_karma(user.id)
    
    await update.message.reply_text(f"🏆 امتیاز کارمای شما: {karma}")

async def cancel(update: Update, context: CallbackContext):
    await update.message.reply_text(
        "عملیات کنسل شد.",
        reply_markup=ReplyKeyboardRemove()
    )
    return ConversationHandler.END

def main():
    # ایجاد اپلیکیشن ربات
    application = Application.builder().token(BOT_TOKEN).build()
    
    # اضافه کردن هندلرها
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("mytasks", my_tasks))
    application.add_handler(CommandHandler("ideas", show_ideas))
    application.add_handler(CommandHandler("karma", show_karma))
    
    # هندلر مکالمه برای ثبت ایده
    conv_handler_idea = ConversationHandler(
        entry_points=[CommandHandler('idea', idea_start)],
        states={
            IDEA_TITLE: [MessageHandler(filters.TEXT & ~filters.COMMAND, idea_title)],
            IDEA_DESCRIPTION: [MessageHandler(filters.TEXT & ~filters.COMMAND, idea_description)],
            IDEA_PRIORITY: [MessageHandler(filters.Regex('^(کم|متوسط|زیاد)$'), idea_priority)],
        },
        fallbacks=[CommandHandler('cancel', cancel)]
    )
    
    # هندلر مکالمه برای ایجاد تسک
    conv_handler_task = ConversationHandler(
        entry_points=[CommandHandler('task', task_start)],
        states={
            TASK_TITLE: [MessageHandler(filters.TEXT & ~filters.COMMAND, task_title)],
            TASK_DESCRIPTION: [MessageHandler(filters.TEXT & ~filters.COMMAND, task_description)],
            TASK_ASSIGNEE: [MessageHandler(filters.TEXT & ~filters.COMMAND, task_assignee)],
            TASK_DUE: [MessageHandler(filters.TEXT & ~filters.COMMAND, task_due)],
        },
        fallbacks=[CommandHandler('cancel', cancel)]
    )
    
    application.add_handler(conv_handler_idea)
    application.add_handler(conv_handler_task)
    
    # شروع ربات
    print("ربات در حال اجراست...")
    application.run_polling()

if __name__ == '__main__':
    main()