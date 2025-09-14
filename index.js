require('dotenv').config();
const { Telegraf, Markup, session, Scenes } = require('telegraf');
const Database = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_USER_IDS = JSON.parse(process.env.ADMIN_USER_IDS || '[]');
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const DB_PATH = process.env.DB_PATH || './team_bot.db';

const db = new Database(DB_PATH);

const bot = new Telegraf(BOT_TOKEN);

// Session
bot.use(session());

// Start command with error handling
bot.start(async (ctx) => {
    const user = ctx.from;
    try {
        const username = user.username || user.first_name || '';  // Fallback
        await db.createUser(user.id, username);
        const welcomeMessage = `
سلام ${user.first_name}! 👋
به ربات مدیریت تیم خوش اومدی!

📝 /idea - ثبت ایده جدید
💡 /ideas - مشاهده ایده‌ها
🏆 /karma - امتیاز من
🎯 /task - ساخت تسک جدید
📋 /mytasks - تسک‌های من
        `.trim();
        await ctx.reply(welcomeMessage);
    } catch (error) {
        console.error('Error in /start:', error);
        await ctx.reply('خطایی در راه‌اندازی رخ داد. بعداً امتحان کن.');
    }
});

// Karma command
bot.command('karma', async (ctx) => {
    try {
        const karma = await db.getUserKarma(ctx.from.id);
        await ctx.reply(`🏆 امتیاز کارمای شما: ${karma}`);
    } catch (error) {
        console.error('Error in /karma:', error);
        await ctx.reply('خطا در دریافت امتیاز.');
    }
});

// Ideas list
bot.command('ideas', async (ctx) => {
    try {
        const ideas = await db.getAllIdeas();
        if (ideas.length === 0) {
            await ctx.reply('هنوز هیچ ایده‌ای ثبت نشده است.');
            return;
        }
        let message = '💡 لیست ایده‌ها:\n\n';
        ideas.forEach((idea, index) => {
            message += `${index + 1}. ${idea.title} (اولویت: ${idea.priority})\n`;
            message += `توضیح: ${idea.description}\n`;
            message += `ثبت شده توسط: @${idea.username}\n`;
            message += `تاریخ: ${new Date(idea.created_at).toLocaleString('fa-IR')}\n\n`;
        });
        await ctx.reply(message);
    } catch (error) {
        console.error('Error fetching ideas:', error);
        await ctx.reply('خطایی در دریافت لیست ایده‌ها رخ داده است.');
    }
});

// Idea Wizard (unchanged, but with try-catch in handlers)
const ideaTitleHandler = async (ctx) => {
    try {
        ctx.session.idea = ctx.session.idea || {};
        ctx.session.idea.title = ctx.message.text;
        await ctx.reply('خوبه! حالا یک توضیح کوتاه برای ایده ات بنویس:');
        return ctx.wizard.next();
    } catch (error) {
        console.error('Error in ideaTitleHandler:', error);
        await ctx.reply('خطا در wizard. /cancel بزن.');
        return ctx.scene.leave();
    }
};

const ideaDescriptionHandler = async (ctx) => {
    try {
        ctx.session.idea.description = ctx.message.text;
        const keyboard = Markup.keyboard([
            ['کم', 'متوسط', 'زیاد']
        ]).oneTime().resize();
        await ctx.reply('اولویت ایده رو انتخاب کن:', keyboard);
        return ctx.wizard.next();
    } catch (error) {
        console.error('Error in ideaDescriptionHandler:', error);
        await ctx.reply('خطا در wizard.');
        return ctx.scene.leave();
    }
};

const ideaPriorityHandler = async (ctx) => {
    try {
        if (!['کم', 'متوسط', 'زیاد'].includes(ctx.message.text)) {
            await ctx.reply('لطفاً یکی از گزینه‌های موجود را انتخاب کنید:');
            return;
        }
        ctx.session.idea.priority = ctx.message.text;
        const ideaId = await db.createIdea(
            ctx.session.idea.title,
            ctx.session.idea.description,
            ctx.from.id,
            ctx.session.idea.priority
        );
        await ctx.reply(
            `ایده تو با موفقیت ثبت شد! 🎉 ID: ${ideaId}\n10 امتیاز کارما گرفتی!`,
            Markup.removeKeyboard()
        );
        // Group notify
        const user = ctx.from;
        const groupMessage = `
ایده جدید ثبت شد! 💡

عنوان: ${ctx.session.idea.title}
توضیحات: ${ctx.session.idea.description}
اولویت: ${ctx.session.idea.priority}
ثبت شده توسط: @${user.username || user.first_name}
        `.trim();
        await bot.telegram.sendMessage(GROUP_CHAT_ID, groupMessage);
    } catch (error) {
        console.error('Error in ideaPriorityHandler:', error);
        await ctx.reply('خطایی در ثبت ایده رخ داده است.');
    } finally {
        delete ctx.session.idea;
        return ctx.scene.leave();
    }
};

const ideaWizard = new Scenes.WizardScene(
    'ideaWizard',
    async (ctx) => {
        await ctx.reply(
            'عالی! می‌خوای یک ایده جدید ثبت کنی.\nلطفاً عنوان ایده رو وارد کن:',
            Markup.removeKeyboard()
        );
        return ctx.wizard.next();
    },
    ideaTitleHandler,
    ideaDescriptionHandler,
    ideaPriorityHandler
);

// Task Wizard (from previous, with fixes)
const taskTitleHandler = async (ctx) => {
    try {
        ctx.session.task = ctx.session.task || {};
        ctx.session.task.title = ctx.message.text;
        await ctx.reply('توضیح کوتاه برای تسک بنویس:');
        return ctx.wizard.next();
    } catch (error) {
        console.error('Error in taskTitleHandler:', error);
        return ctx.scene.leave();
    }
};

const taskDescriptionHandler = async (ctx) => {
    try {
        ctx.session.task.description = ctx.message.text;
        await ctx.reply('assign به کی؟ (مثل @username یا "خودم"):', Markup.forceReply());
        return ctx.wizard.next();
    } catch (error) {
        console.error('Error in taskDescriptionHandler:', error);
        return ctx.scene.leave();
    }
};

const taskAssigneeHandler = async (ctx) => {
    try {
        let assigneeUsername = ctx.message.text.replace('@', '');
        if (assigneeUsername === 'خودم') {
            assigneeUsername = ctx.from.username || '';
        }
        ctx.session.task.assignee = assigneeUsername;
        await ctx.reply('deadline رو وارد کن (فرمت: YYYY-MM-DD):', Markup.forceReply());
        return ctx.wizard.next();
    } catch (error) {
        console.error('Error in taskAssigneeHandler:', error);
        return ctx.scene.leave();
    }
};

const taskDeadlineHandler = async (ctx) => {
    try {
        const deadline = ctx.message.text;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
            await ctx.reply('فرمت اشتباهه! دوباره وارد کن (YYYY-MM-DD):');
            return;
        }
        ctx.session.task.deadline = deadline;
        ctx.session.task.status = 'ToDo';
        const taskId = await db.createTask(
            ctx.session.task.title,
            ctx.session.task.description,
            ctx.session.task.assignee,
            deadline,
            ctx.session.task.status,
            ctx.from.id
        );
        await ctx.reply(
            `تسک با موفقیت ساخته شد! 🎯 ID: ${taskId}\nوضعیت: ${ctx.session.task.status}`,
            Markup.removeKeyboard()
        );
        // Notify assignee if not self
        if (ctx.session.task.assignee && ctx.session.task.assignee !== (ctx.from.username || '')) {
            const assigneeUser = await db.getUserByUsername(ctx.session.task.assignee);
            if (assigneeUser) {
                await bot.telegram.sendMessage(assigneeUser.user_id, 
                    `تسک جدید برات assign شد: ${ctx.session.task.title}\nمهلت: ${deadline}`
                );
            }
        }
        // Group message
        const groupMessage = `
🎯 تسک جدید: ${ctx.session.task.title}
توضیح: ${ctx.session.task.description}
مسئول: @${ctx.session.task.assignee}
مهلت: ${deadline}
وضعیت: ${ctx.session.task.status}
ثبت شده توسط: @${ctx.from.username || ctx.from.first_name}
        `.trim();
        await bot.telegram.sendMessage(GROUP_CHAT_ID, groupMessage);
    } catch (error) {
        console.error('Error in taskDeadlineHandler:', error);
        await ctx.reply('خطایی در ساخت تسک رخ داد.');
    } finally {
        delete ctx.session.task;
        return ctx.scene.leave();
    }
};

const taskWizard = new Scenes.WizardScene(
    'taskWizard',
    async (ctx) => {
        await ctx.reply(
            'عالی! تسک جدید می‌سازیم.\nعنوان تسک رو وارد کن:',
            Markup.removeKeyboard()
        );
        return ctx.wizard.next();
    },
    taskTitleHandler,
    taskDescriptionHandler,
    taskAssigneeHandler,
    taskDeadlineHandler
);

// Stage
const stage = new Scenes.Stage([ideaWizard, taskWizard]);
bot.use(stage.middleware());

// Commands
bot.command('idea', (ctx) => ctx.scene.enter('ideaWizard'));
bot.command('task', (ctx) => ctx.scene.enter('taskWizard'));

bot.command('mytasks', async (ctx) => {
    try {
        const username = ctx.from.username || '';
        const tasks = await db.getUserTasks(ctx.from.id);  // Pass userId, but query by username
        if (tasks.length === 0) {
            await ctx.reply('هیچ تسکی نداری!');
            return;
        }
        let message = '📋 تسک‌های تو:\n\n';
        tasks.forEach(task => {
            message += `• ${task.title} (وضعیت: ${task.status}, مهلت: ${task.deadline})\n`;
        });
        await ctx.reply(message);
    } catch (error) {
        console.error('Error in /mytasks:', error);
        await ctx.reply('خطا در دریافت تسک‌ها.');
    }
});

bot.command('cancel', async (ctx) => {
    if (ctx.session.idea) delete ctx.session.idea;
    if (ctx.session.task) delete ctx.session.task;
    await ctx.reply('عملیات کنسل شد.', Markup.removeKeyboard());
    return ctx.scene.leave();
});

// Global error handling
bot.catch((err, ctx) => {
    console.error('Telegraf Error:', err);
    if (ctx) ctx.reply('متأسفم، خطایی در سرویس رخ داده است.');
});

// Express for Render health check
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('ربات تلگرام در حال اجراست!');
});

app.listen(PORT, () => {
    console.log(`سرور در پورت ${PORT} در حال اجراست`);
});

// Launch
bot.launch().then(() => {
    console.log('ربات در حال اجراست...');
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));