require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const Database = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_USER_IDS = JSON.parse(process.env.ADMIN_USER_IDS);
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const DB_PATH = process.env.DB_PATH;

const db = new Database(DB_PATH);

const bot = new Telegraf(BOT_TOKEN);

// Session and conversation states
bot.use(session());

// Start command
bot.start(async (ctx) => {
    const user = ctx.from;
    await db.createUser(user.id, user.username);
    
    const welcomeMessage = `
سلام ${user.first_name}! 👋
به ربات مدیریت تیم خوش اومدی!

📝 /idea - ثبت ایده جدید
💡 /ideas - مشاهده ایده‌ها
🏆 /karma - امتیاز من
    `.trim();
    
    await ctx.reply(welcomeMessage);
});

// Karma command
bot.command('karma', async (ctx) => {
    const karma = await db.getUserKarma(ctx.from.id);
    await ctx.reply(`🏆 امتیاز کارمای شما: ${karma}`);
});

// Ideas list command
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
            message += `ثبت شده توسط: @${idea.username || 'ناشناس'}\n`;
            message += `تاریخ: ${new Date(idea.created_at).toLocaleString('fa-IR')}\n\n`;
        });
        
        await ctx.reply(message);
    } catch (error) {
        console.error('Error fetching ideas:', error);
        await ctx.reply('خطایی در دریافت لیست ایده‌ها رخ داده است.');
    }
});

// Idea conversation
bot.command('idea', async (ctx) => {
    ctx.session.idea = {};
    await ctx.reply(
        'عالی! می‌خوای یک ایده جدید ثبت کنی.\nلطفاً عنوان ایده رو وارد کن:',
        Markup.removeKeyboard()
    );
    return ctx.wizard.next();
});

// Wizard steps for idea creation
const ideaWizard = {
    title: async (ctx) => {
        ctx.session.idea.title = ctx.message.text;
        await ctx.reply('خوبه! حالا یک توضیح کوتاه برای ایده ات بنویس:');
        return ctx.wizard.next();
    },
    description: async (ctx) => {
        ctx.session.idea.description = ctx.message.text;
        
        const keyboard = Markup.keyboard([
            ['کم', 'متوسط', 'زیاد']
        ]).oneTime().resize();
        
        await ctx.reply(
            'اولویت ایده رو انتخاب کن:',
            keyboard
        );
        return ctx.wizard.next();
    },
    priority: async (ctx) => {
        if (!['کم', 'متوسط', 'زیاد'].includes(ctx.message.text)) {
            await ctx.reply('لطفاً یکی از گزینه‌های موجود را انتخاب کنید:');
            return;
        }
        
        ctx.session.idea.priority = ctx.message.text;
        
        try {
            await db.createIdea(
                ctx.session.idea.title,
                ctx.session.idea.description,
                ctx.from.id,
                ctx.session.idea.priority
            );
            
            await ctx.reply(
                'ایده تو با موفقیت ثبت شد! 🎉\n10 امتیاز کارما گرفتی!',
                Markup.removeKeyboard()
            );
            
            // Send notification to group
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
            console.error('Error creating idea:', error);
            await ctx.reply('خطایی در ثبت ایده رخ داده است.');
        }
        
        delete ctx.session.idea;
        return ctx.scene.leave();
    }
};

// Setup wizard
const { Scenes: { WizardScene } } = require('telegraf');
const ideaScene = new WizardScene(
    'ideaScene',
    ideaWizard.title,
    ideaWizard.description,
    ideaWizard.priority
);

const { Stage } = require('telegraf');
const stage = new Stage([ideaScene]);
bot.use(stage.middleware());

// Cancel command
bot.command('cancel', async (ctx) => {
    if (ctx.session.idea) {
        delete ctx.session.idea;
    }
    
    await ctx.reply(
        'عملیات کنسل شد.',
        Markup.removeKeyboard()
    );
    
    return ctx.scene.leave();
});

// Error handling
bot.catch((err, ctx) => {
    console.error('Telegraf Error:', err);
    ctx.reply('متأسفم، خطایی در سرویس رخ داده است.');
});

// Start the bot
bot.launch().then(() => {
    console.log('ربات در حال اجراست...');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));