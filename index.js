require('dotenv').config();
const { Telegraf, Markup, session, Scenes } = require('telegraf');
const cron = require('node-cron');
const Database = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_USER_IDS = JSON.parse(process.env.ADMIN_USER_IDS || '[]');
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const DB_PATH = process.env.DB_PATH || './team_bot.db';
const STANDUP_TIME = process.env.STANDUP_TIME || '18:00';
const PORT = process.env.PORT || 3000;

const db = new Database(DB_PATH);
const bot = new Telegraf(BOT_TOKEN);

// ============ MIDDLEWARES ============
bot.use(session());
bot.use(async (ctx, next) => {
    if (ctx.from) {
        await db.createUser(ctx.from.id, ctx.from.username || ctx.from.first_name);
        await db.updateUserLastActive(ctx.from.id);
    }
    return next();
});

// ============ UTILITY FUNCTIONS ============
const isAdmin = async (userId) => {
    if (ADMIN_USER_IDS.includes(userId)) return true;
    return await db.isAdmin(userId);
};

const sendToGroup = async (message, options = {}) => {
    try {
        await bot.telegram.sendMessage(GROUP_CHAT_ID, message, options);
    } catch (error) {
        console.error('Error sending message to group:', error);
    }
};

// ============ WIZARD SCENES ============

// IDEA WIZARD
const ideaWizard = new Scenes.WizardScene(
    'ideaWizard',
    async (ctx) => {
        await ctx.reply('عالی! عنوان ایده رو وارد کن:', Markup.removeKeyboard());
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.session.idea = ctx.session.idea || {};
        ctx.session.idea.title = ctx.message.text;
        await ctx.reply('توضیح کوتاه برای ایده ات بنویس:');
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.session.idea.description = ctx.message.text;
        const keyboard = Markup.keyboard([['کم', 'متوسط', 'زیاد']]).oneTime().resize();
        await ctx.reply('اولویت ایده رو انتخاب کن:', keyboard);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!['کم', 'متوسط', 'زیاد'].includes(ctx.message.text)) {
            await ctx.reply('لطفاً یکی از گزینه‌های موجود را انتخاب کنید:');
            return;
        }

        try {
            const priorityMap = { 'کم': 'low', 'متوسط': 'medium', 'زیاد': 'high' };
            const priority = priorityMap[ctx.message.text];
            
            const ideaId = await db.createIdea(
                ctx.session.idea.title,
                ctx.session.idea.description,
                ctx.from.id,
                priority
            );

            await ctx.reply(
                `ایده تو با موفقیت ثبت شد! 🎉 ID: ${ideaId}\n10 امتیاز کارما گرفتی!`,
                Markup.removeKeyboard()
            );

            // Send to group
            const user = ctx.from;
            const groupMessage = `
💡 ایده جدید ثبت شد!

عنوان: ${ctx.session.idea.title}
توضیحات: ${ctx.session.idea.description}
اولویت: ${ctx.message.text}
ثبت شده توسط: @${user.username || user.first_name}

[رأی بده] [ایجاد تسک] [جزئیات]
            `.trim();

            await sendToGroup(groupMessage, Markup.inlineKeyboard([
                [Markup.button.callback('👍 رأی بده', `vote_idea_${ideaId}`)],
                [Markup.button.callback('🎯 ایجاد تسک', `create_task_${ideaId}`),
                 Markup.button.callback('📋 جزئیات', `idea_details_${ideaId}`)]
            ]));

        } catch (error) {
            console.error('Error creating idea:', error);
            await ctx.reply('خطایی در ثبت ایده رخ داده است.');
        } finally {
            delete ctx.session.idea;
            return ctx.scene.leave();
        }
    }
);

// TASK WIZARD
const taskWizard = new Scenes.WizardScene(
    'taskWizard',
    async (ctx) => {
        await ctx.reply('عنوان تسک رو وارد کن:', Markup.removeKeyboard());
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.session.task = ctx.session.task || {};
        ctx.session.task.title = ctx.message.text;
        await ctx.reply('توضیح کوتاه برای تسک بنویس:');
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.session.task.description = ctx.message.text;
        await ctx.reply('Assign به کی؟ (@username یا "خودم"):', Markup.forceReply());
        return ctx.wizard.next();
    },
    async (ctx) => {
        try {
            let assigneeUsername = ctx.message.text.replace('@', '').trim();
            let assigneeId = null;

            if (assigneeUsername === 'خودم') {
                assigneeId = ctx.from.id;
                assigneeUsername = ctx.from.username || ctx.from.first_name;
            } else {
                const user = await db.getUserByUsername(assigneeUsername);
                if (!user) {
                    await ctx.reply('کاربر مورد نظر یافت نشد! لطفاً username صحیح وارد کنید:');
                    return;
                }
                assigneeId = user.user_id;
            }

            ctx.session.task.assigneeId = assigneeId;
            ctx.session.task.assigneeUsername = assigneeUsername;
            
            await ctx.reply('Deadline رو وارد کن (YYYY-MM-DD):', Markup.forceReply());
            return ctx.wizard.next();
        } catch (error) {
            console.error('Error finding user:', error);
            await ctx.reply('خطا در یافتن کاربر. لطفاً دوباره تلاش کنید.');
            return ctx.scene.leave();
        }
    },
    async (ctx) => {
        const deadline = ctx.message.text;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
            await ctx.reply('فرمت اشتباهه! دوباره وارد کن (YYYY-MM-DD):');
            return;
        }

        try {
            const taskId = await db.createTask(
                ctx.session.task.title,
                ctx.session.task.description,
                ctx.session.task.assigneeId,
                ctx.session.task.assigneeUsername,
                deadline,
                'ToDo',
                ctx.from.id
            );

            await ctx.reply(
                `تسک با موفقیت ساخته شد! 🎯 ID: ${taskId}`,
                Markup.removeKeyboard()
            );

            // Notify assignee
            if (ctx.session.task.assigneeId !== ctx.from.id) {
                await bot.telegram.sendMessage(
                    ctx.session.task.assigneeId,
                    `🎯 تسک جدید برات assign شد:\n\n${ctx.session.task.title}\nمهلت: ${deadline}\n\nوضعیت: ToDo`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('▶️ شروع', `task_start_${taskId}`)],
                        [Markup.button.callback('📋 جزئیات', `task_details_${taskId}`)]
                    ])
                );
            }

            // Send to group
            const groupMessage = `
🎯 تسک جدید ایجاد شد!

عنوان: ${ctx.session.task.title}
توضیحات: ${ctx.session.task.description}
مسئول: @${ctx.session.task.assigneeUsername}
مهلت: ${deadline}
وضعیت: ToDo
ثبت شده توسط: @${ctx.from.username || ctx.from.first_name}
            `.trim();

            await sendToGroup(groupMessage, Markup.inlineKeyboard([
                [Markup.button.callback('▶️ شروع', `task_start_${taskId}`),
                 Markup.button.callback('✔️ انجام شد', `task_done_${taskId}`)],
                [Markup.button.callback('📋 جزئیات', `task_details_${taskId}`),
                 Markup.button.callback('💬 کامنت', `task_comment_${taskId}`)]
            ]));

        } catch (error) {
            console.error('Error creating task:', error);
            await ctx.reply('خطایی در ساخت تسک رخ داد.');
        } finally {
            delete ctx.session.task;
            return ctx.scene.leave();
        }
    }
);

// STANDUP WIZARD
const standupWizard = new Scenes.WizardScene(
    'standupWizard',
    async (ctx) => {
        await ctx.reply('دیروز چه کارهایی انجام دادی؟', Markup.removeKeyboard());
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.session.standup = ctx.session.standup || {};
        ctx.session.standup.yesterday = ctx.message.text;
        await ctx.reply('امروز چه برنامه‌ای داری؟');
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.session.standup.today = ctx.message.text;
        await ctx.reply('چه blocker یا مشکلی داری؟ (اگر نداری بنویس "ندارم")');
        return ctx.wizard.next();
    },
    async (ctx) => {
        try {
            const blocker = ctx.message.text;
            const today = new Date().toISOString().split('T')[0];
            
            await db.createStandup(
                ctx.from.id,
                today,
                ctx.session.standup.yesterday,
                ctx.session.standup.today,
                blocker
            );

            await db.addKarma(ctx.from.id, 5); // Karma for standup

            await ctx.reply('استندآپ تو ثبت شد! ✅ 5 امتیاز کارما گرفتی!');

            // Notify admin if there's a blocker
            if (blocker.toLowerCase() !== 'ندارم') {
                const adminMessage = `
⚠️ کاربر @${ctx.from.username || ctx.from.first_name} blocker گزارش داده:

${blocker}
                `.trim();

                for (const adminId of ADMIN_USER_IDS) {
                    await bot.telegram.sendMessage(adminId, adminMessage);
                }
            }

        } catch (error) {
            console.error('Error saving standup:', error);
            await ctx.reply('خطایی در ثبت استندآپ رخ داد.');
        } finally {
            delete ctx.session.standup;
            return ctx.scene.leave();
        }
    }
);

// POLL WIZARD (برای ادمین‌ها)
const pollWizard = new Scenes.WizardScene(
    'pollWizard',
    async (ctx) => {
        if (!await isAdmin(ctx.from.id)) {
            await ctx.reply('شما دسترسی لازم برای ایجاد نظرسنجی را ندارید.');
            return ctx.scene.leave();
        }
        await ctx.reply('عنوان نظرسنجی رو وارد کن:', Markup.removeKeyboard());
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.session.poll = ctx.session.poll || {};
        ctx.session.poll.title = ctx.message.text;
        await ctx.reply('گزینه‌ها رو وارد کن (با کاما جدا کن):\nمثال: گزینه اول, گزینه دوم, گزینه سوم');
        return ctx.wizard.next();
    },
    async (ctx) => {
        try {
            const options = ctx.message.text.split(',').map(opt => opt.trim()).filter(opt => opt);
            
            if (options.length < 2) {
                await ctx.reply('حداقل ۲ گزینه لازم است. دوباره وارد کن:');
                return;
            }

            const pollId = await db.createPoll(
                ctx.session.poll.title,
                options,
                ctx.from.id
            );

            // Send poll to group
            const pollButtons = options.map((option, index) => 
                [Markup.button.callback(option, `poll_vote_${pollId}_${index}`)]
            );

            await sendToGroup(
                `📊 نظرسنجی جدید:\n\n${ctx.session.poll.title}`,
                Markup.inlineKeyboard(pollButtons)
            );

            await ctx.reply('نظرسنجی با موفقیت ایجاد شد!');

        } catch (error) {
            console.error('Error creating poll:', error);
            await ctx.reply('خطایی در ایجاد نظرسنجی رخ داد.');
        } finally {
            delete ctx.session.poll;
            return ctx.scene.leave();
        }
    }
);

// ============ STAGE SETUP ============
const stage = new Scenes.Stage([ideaWizard, taskWizard, standupWizard, pollWizard]);
bot.use(stage.middleware());

// ============ COMMAND HANDLERS ============

// START COMMAND
bot.start(async (ctx) => {
    try {
        // ابتدا کاربر رو ایجاد یا آپدیت کن
        await db.createUser(ctx.from.id, ctx.from.username || ctx.from.first_name);
        
        // بررسی کن آیا کاربر قبلاً قوانین رو پذیرفته
        const user = await db.getUser(ctx.from.id);
        
        if (user && user.accepted_rules) {
            // کاربر قبلاً قوانین رو پذیرفته
            const welcomeMessage = `
سلام ${ctx.from.first_name}! 👋
به ربات مدیریت تیم خوش اومدی!

📝 /idea - ثبت ایده جدید
💡 /ideas - مشاهده ایده‌ها
🏆 /karma - امتیاز من
🎯 /task - ساخت تسک جدید
📋 /mytasks - تسک‌های من
⏱ /standup - استندآپ روزانه
📊 /poll - ایجاد نظرسنجی (ادمین)
📁 /upload - آپلود فایل
📅 /calendar - تقویم جلسات
👥 /members - مدیریت اعضا (ادمین)

برای شروع /help رو بزن.
            `.trim();

            await ctx.reply(welcomeMessage);
        } else {
            // کاربر هنوز قوانین رو نپذیرفته
            const welcomeMessage = `
سلام ${ctx.from.first_name}! 👋
به ربات مدیریت تیم خوش اومدی!

📝 /idea - ثبت ایده جدید
💡 /ideas - مشاهده ایده‌ها
🏆 /karma - امتیاز من
🎯 /task - ساخت تسک جدید
📋 /mytasks - تسک‌های من
            `.trim();

            await ctx.reply(welcomeMessage);

            // Send rules and ask for acceptance
            const rulesMessage = `
📋 قوانین تیم:

1. احترام متقابل به همه اعضا
2. ثبت منظم استندآپ روزانه
3. پیگیری تسک‌های محوله
4. مشارکت در بحث‌های تیمی

آیا قوانین رو می‌پذیری؟
            `.trim();

            await ctx.reply(rulesMessage, Markup.inlineKeyboard([
                Markup.button.callback('✅ قبول می‌کنم', 'accept_rules'),
                Markup.button.callback('❌ نمی‌پذیرم', 'reject_rules')
            ]));
        }
    } catch (error) {
        console.error('Error in start command:', error);
        await ctx.reply('خطایی در پردازش درخواست شما رخ داده است.');
    }
});

// HELP COMMAND
bot.help(async (ctx) => {
    const helpMessage = `
🤖 راهنمای ربات مدیریت تیم:

📝 ایده‌ها:
/idea - ثبت ایده جدید
/ideas - مشاهده همه ایده‌ها

🎯 تسک‌ها:
/task - ایجاد تسک جدید
/mytasks - تسک‌های من

⏱ استندآپ:
/standup - ثبت گزارش روزانه

📊 نظرسنجی:
/poll - ایجاد نظرسنجی (ادمین)

📁 فایل‌ها:
/upload - آپلود فایل
/files - جستجوی فایل

🏆 امتیاز:
/karma - مشاهده امتیاز کارما

👥 مدیریت (ادمین):
/members - مدیریت اعضا
/announce - ارسال اطلاعیه
/dashboard - آمار تیم

❌ /cancel - لغو عملیات جاری
    `.trim();

    await ctx.reply(helpMessage);
});

// CANCEL COMMAND
bot.command('cancel', async (ctx) => {
    ['idea', 'task', 'standup', 'poll'].forEach(key => {
        if (ctx.session[key]) delete ctx.session[key];
    });
    await ctx.reply('عملیات کنسل شد.', Markup.removeKeyboard());
    return ctx.scene.leave();
});

// KARMA COMMAND
bot.command('karma', async (ctx) => {
    try {
        const karma = await db.getUserKarma(ctx.from.id);
        const topUsers = await db.getTopUsersByKarma(5);
        
        let message = `🏆 امتیاز کارمای شما: ${karma}\n\n`;
        message += '📊 برترین‌ها:\n';
        
        topUsers.forEach((user, index) => {
            message += `${index + 1}. @${user.username || 'ناشناس'}: ${user.karma}\n`;
        });

        await ctx.reply(message);
    } catch (error) {
        console.error('Error in /karma:', error);
        await ctx.reply('خطا در دریافت امتیاز.');
    }
});

// IDEAS COMMAND
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
            message += `تاریخ: ${new Date(idea.created_at).toLocaleString('fa-IR')}\n`;
            message += `رأی: ${idea.vote_count} 👍\n\n`;
        });

        await ctx.reply(message);
    } catch (error) {
        console.error('Error fetching ideas:', error);
        await ctx.reply('خطایی در دریافت لیست ایده‌ها رخ داده است.');
    }
});

// MYTASKS COMMAND
bot.command('mytasks', async (ctx) => {
    try {
        const tasks = await db.getUserTasks(ctx.from.id);
        if (tasks.length === 0) {
            await ctx.reply('هیچ تسکی نداری!');
            return;
        }

        let message = '📋 تسک‌های تو:\n\n';
        tasks.forEach((task, index) => {
            message += `${index + 1}. ${task.title}\n`;
            message += `وضعیت: ${task.status} | مهلت: ${task.deadline}\n`;
            message += `ساخته شده توسط: @${task.creator_username}\n\n`;
        });

        await ctx.reply(message);
    } catch (error) {
        console.error('Error in /mytasks:', error);
        await ctx.reply('خطا در دریافت تسک‌ها.');
    }
});

// STANDUP COMMAND
bot.command('standup', (ctx) => ctx.scene.enter('standupWizard'));

// POLL COMMAND (برای ادمین)
bot.command('poll', (ctx) => ctx.scene.enter('pollWizard'));

// UPLOAD COMMAND
bot.command('upload', async (ctx) => {
    await ctx.reply('لطفاً فایل مورد نظر رو ارسال کن:');
});

// DASHBOARD COMMAND (برای ادمین)
bot.command('dashboard', async (ctx) => {
    if (!await isAdmin(ctx.from.id)) {
        await ctx.reply('شما دسترسی لازم برای مشاهده داشبورد را ندارید.');
        return;
    }

    try {
        const stats = await db.getDashboardStats();
        const message = `
📊 داشبورد تیم:

👥 تعداد اعضا: ${stats.total_users}
💡 ایده‌های ثبت شده: ${stats.total_ideas}
✅ تسک‌های انجام شده: ${stats.completed_tasks} از ${stats.total_tasks}
🎯 نرخ تکمیل: ${stats.total_tasks > 0 ? Math.round((stats.completed_tasks / stats.total_tasks) * 100) : 0}%
👤 اعضای فعال (۷ روز): ${stats.active_users}
        `.trim();

        await ctx.reply(message);
    } catch (error) {
        console.error('Error fetching dashboard:', error);
        await ctx.reply('خطا در دریافت آمار.');
    }
});

// ============ FILE HANDLING ============
bot.on('document', async (ctx) => {
    try {
        const fileId = ctx.message.document.file_id;
        const fileName = ctx.message.document.file_name;
        
        await ctx.reply('برچسب‌های فایل رو وارد کن (با کاما جدا کن):');
        
        // Store file info in session for next message
        ctx.session.uploadingFile = { fileId, fileName };
    } catch (error) {
        console.error('Error handling file:', error);
        await ctx.reply('خطا در پردازش فایل.');
    }
});

// Handle file tags
bot.on('text', async (ctx) => {
    if (ctx.session.uploadingFile) {
        try {
            const { fileId, fileName } = ctx.session.uploadingFile;
            const tags = ctx.message.text;
            
            const fileDbId = await db.saveFile(ctx.from.id, fileId, fileName, tags);
            
            await ctx.reply(`فایل "${fileName}" با موفقیت آپلود شد! 🎉`);
            
            // Send to group
            const groupMessage = `
📁 فایل جدید آپلود شد:

نام: ${fileName}
برچسب‌ها: ${tags}
آپلود شده توسط: @${ctx.from.username || ctx.from.first_name}
            `.trim();

            await sendToGroup(groupMessage, Markup.inlineKeyboard([
                [Markup.button.callback('📥 دانلود', `download_${fileDbId}`)]
            ]));

            delete ctx.session.uploadingFile;
        } catch (error) {
            console.error('Error saving file:', error);
            await ctx.reply('خطا در ذخیره فایل.');
        }
    }
});

// ============ INLINE QUERY HANDLING ============
bot.on('inline_query', async (ctx) => {
    try {
        const query = ctx.inlineQuery.query;
        if (!query) return;

        const results = await db.searchContent(query);
        
        const inlineResults = results.map((item, index) => {
            return {
                type: 'article',
                id: index.toString(),
                title: item.title,
                description: item.description.substring(0, 64),
                input_message_content: {
                    message_text: `🔍 نتیجه جستجو:\n\n${item.title}\n${item.description.substring(0, 128)}...`
                }
            };
        });

        await ctx.answerInlineQuery(inlineResults);
    } catch (error) {
        console.error('Error handling inline query:', error);
    }
});

// ============ CALLBACK QUERY HANDLERS ============
bot.action(/accept_rules/, async (ctx) => {
    try {
        await db.acceptRules(ctx.from.id);
        await ctx.editMessageText('✅ قوانین را پذیرفتی! خوش اومدی به تیم!');
        await ctx.answerCbQuery();
    } catch (error) {
        console.error('Error accepting rules:', error);
        await ctx.answerCbQuery('خطا در پذیرش قوانین');
    }
});

bot.action(/reject_rules/, async (ctx) => {
    await ctx.editMessageText('❌ متأسفیم بدون پذیرش قوانین نمی‌تونی از ربات استفاده کنی.');
    await ctx.answerCbQuery();
});

bot.action(/vote_idea_(\d+)/, async (ctx) => {
    try {
        const ideaId = ctx.match[1];
        const voted = await db.voteForIdea(ctx.from.id, ideaId);
        
        if (voted) {
            await ctx.answerCbQuery('👍 رأی تو ثبت شد!');
            await ctx.editMessageText(
                ctx.update.callback_query.message.text + `\n\n✅ @${ctx.from.username} رأی داد`,
                ctx.update.callback_query.message.reply_markup
            );
        } else {
            await ctx.answerCbQuery('❌ قبلاً به این ایده رأی دادی!');
        }
    } catch (error) {
        console.error('Error voting for idea:', error);
        await ctx.answerCbQuery('خطا در ثبت رأی');
    }
});

bot.action(/task_start_(\d+)/, async (ctx) => {
    try {
        const taskId = ctx.match[1];
        const updated = await db.updateTaskStatus(taskId, 'In Progress');
        
        if (updated) {
            await ctx.answerCbQuery('✅ تسک شروع شد!');
            await ctx.editMessageText(
                ctx.update.callback_query.message.text.replace('وضعیت: ToDo', 'وضعیت: In Progress'),
                ctx.update.callback_query.message.reply_markup
            );
        }
    } catch (error) {
        console.error('Error starting task:', error);
        await ctx.answerCbQuery('خطا در شروع تسک');
    }
});

bot.action(/task_done_(\d+)/, async (ctx) => {
    try {
        const taskId = ctx.match[1];
        const updated = await db.updateTaskStatus(taskId, 'Done');
        
        if (updated) {
            await ctx.answerCbQuery('🎉 تسک انجام شد! 30 امتیاز کارما گرفتی!');
            await ctx.editMessageText(
                ctx.update.callback_query.message.text.replace('وضعیت: ToDo', 'وضعیت: Done ✅'),
                ctx.update.callback_query.message.reply_markup
            );
        }
    } catch (error) {
        console.error('Error completing task:', error);
        await ctx.answerCbQuery('خطا در تکمیل تسک');
    }
});

// ============ CRON JOBS ============
// استندآپ روزانه
cron.schedule(`0 ${STANDUP_TIME.split(':')[1]} ${STANDUP_TIME.split(':')[0]} * * *`, async () => {
    try {
        const users = await db.getTopUsersByKarma(50); // Get active users
        
        for (const user of users) {
            await bot.telegram.sendMessage(
                user.user_id,
                `⏱ وقت استندآپ روزانه!\n\nلطفاً گزارش امروزتو ارسال کن:\n/standup`
            );
        }
        
        await sendToGroup('⏱ وقت استندآپ روزانه! لطفاً گزارش‌هاتون رو از طریق ربات ارسال کنید.');
    } catch (error) {
        console.error('Error in standup cron job:', error);
    }
});

// بررسی تسک‌های Overdue
cron.schedule('0 9 * * *', async () => {
    try {
        const overdueTasks = await db.getOverdueTasks();
        
        for (const task of overdueTasks) {
            await db.updateTaskStatus(task.id, 'Overdue');
            
            // notify assignee
            const assigneeUser = await db.getUser(task.assignee_id);
            if (assigneeUser) {
                await bot.telegram.sendMessage(
                    task.assignee_id,
                    `⚠️ تسک "${task.title}" overdue شده! لطفاً پیگیری کن.`
                );
            }
            
            // notify admin
            for (const adminId of ADMIN_USER_IDS) {
                await bot.telegram.sendMessage(
                    adminId,
                    `⚠️ تسک "${task.title}" overdue شده! مسئول: @${task.assignee_username}`
                );
            }
        }
    } catch (error) {
        console.error('Error in overdue tasks cron job:', error);
    }
});

// ============ ERROR HANDLING ============
bot.catch((err, ctx) => {
    console.error('Telegraf Error:', err);
    if (ctx) ctx.reply('متأسفم، خطایی در سرویس رخ داده است.');
});

// ============ EXPRESS SERVER FOR WEBHOOK ============
const express = require('express');
const app = express();

app.use(express.json());
app.get('/', (req, res) => res.send('ربات تلگرام در حال اجراست!'));

// Webhook setup for Render
let isWebhookSetup = false;

app.listen(PORT, async () => {
    console.log(`سرور در پورت ${PORT} در حال اجراست`);
    
    // Set webhook in production
    if (process.env.NODE_ENV === 'production') {
        try {
            const domain = process.env.RENDER_EXTERNAL_URL;
            await bot.telegram.setWebhook(`${domain}/bot${BOT_TOKEN}`);
            app.post(`/bot${BOT_TOKEN}`, (req, res) => {
                bot.handleUpdate(req.body, res);
            });
            isWebhookSetup = true;
            console.log('Webhook setup successfully');
        } catch (error) {
            console.error('Error setting webhook:', error);
        }
    }
});

// ============ BOT LAUNCH ============
if (process.env.NODE_ENV !== 'production') {
    bot.launch().then(() => {
        console.log('ربات در حال اجراست... (Polling Mode)');
    });
}

// Graceful stop - فقط در حالت polling
if (process.env.NODE_ENV !== 'production') {
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
} else {
    // در حالت production فقط webhook رو حذف کنیم
    process.once('SIGINT', async () => {
        if (isWebhookSetup) {
            await bot.telegram.deleteWebhook();
            console.log('Webhook deleted');
        }
        process.exit(0);
    });
    process.once('SIGTERM', async () => {
        if (isWebhookSetup) {
            await bot.telegram.deleteWebhook();
            console.log('Webhook deleted');
        }
        process.exit(0);
    });
}