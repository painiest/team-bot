require('dotenv').config();

// درست: Scenes رو بگیر و از داخلش WizardScene و Stage رو استخراج کن
const { Telegraf, Markup, session, Composer } = require('telegraf');
const { Scenes } = require('telegraf');    // Scenes یک آبجکت است
const { WizardScene, Stage } = Scenes;     // از داخل Scenes استخراج می‌کنیم

const cron = require('node-cron');
const express = require('express');
const Database = require('./database'); // نسخه‌ای که قبلاً بازنویسی شد

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN در .env تنظیم نشده');
  process.exit(1);
}
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS ? JSON.parse(process.env.ADMIN_USER_IDS) : [];
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || null;
const DB_PATH = process.env.DB_PATH || './team_bot.db';
const STANDUP_TIME = process.env.STANDUP_TIME || '18:00'; // فرمت HH:MM
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ---------- Init ----------
const db = new Database(DB_PATH);
const bot = new Telegraf(BOT_TOKEN);

// ---------- Middlewares ----------
bot.use(session());

// هر پیام از کاربر => اطمینان از وجود کاربر در DB و آپدیت last_active
bot.use(async (ctx, next) => {
  try {
    if (ctx.from && ctx.from.id) {
      await db.createUser(ctx.from.id, ctx.from.username || ctx.from.first_name || '');
      await db.updateUserLastActive(ctx.from.id);
    }
  } catch (e) {
    console.error('middleware db.createUser/updateUserLastActive error:', e);
  }
  return next();
});

// ---------- Utility ----------
const isAdmin = async (userId) => {
  if (!userId) return false;
  if (ADMIN_USER_IDS.includes(userId)) return true;
  try {
    return await db.isAdmin(userId);
  } catch (e) {
    console.error('isAdmin error:', e);
    return false;
  }
};

const sendToGroup = async (text, extra = {}) => {
  if (!GROUP_CHAT_ID) {
    console.warn('GROUP_CHAT_ID تنظیم نشده؛ پیام گروه فرستاده نشد.');
    return;
  }
  try {
    await bot.telegram.sendMessage(GROUP_CHAT_ID, text, extra);
  } catch (e) {
    console.error('sendToGroup error:', e);
  }
};

// ---------- Scenes (Wizard) ----------

// -- Idea Wizard (ثبت ایده) --
const ideaWizard = new WizardScene(
  'ideaWizard',
  async (ctx) => {
    await ctx.reply('عالی! عنوان ایده رو بنویس: (یا /cancel برای لغو)');
    ctx.wizard.state.idea = {};
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      await ctx.reply('عنوان معتبر نیست، لطفاً متن وارد کن.');
      return;
    }
    ctx.wizard.state.idea.title = ctx.message.text.trim();
    await ctx.reply('توضیح کوتاه برای ایده‌ات رو بنویس:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      await ctx.reply('توضیح معتبر نیست، لطفاً متن وارد کن.');
      return;
    }
    ctx.wizard.state.idea.description = ctx.message.text.trim();
    const keyboard = Markup.keyboard([['کم','متوسط','زیاد']]).oneTime().resize();
    await ctx.reply('اولویت ایده رو انتخاب کن:', keyboard);
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      await ctx.reply('لطفاً یکی از گزینه‌ها را انتخاب کن.');
      return;
    }
    const mapping = { 'کم':'low', 'متوسط':'medium', 'زیاد':'high' };
    const input = ctx.message.text.trim();
    if (!mapping[input]) {
      await ctx.reply('یک گزینه معتبر انتخاب کن: کم، متوسط یا زیاد');
      return;
    }

    try {
      const ideaId = await db.createIdea(
        ctx.wizard.state.idea.title,
        ctx.wizard.state.idea.description,
        ctx.from.id,
        mapping[input]
      );

      await ctx.reply(`ایده با موفقیت ثبت شد. (ID: ${ideaId})`, Markup.removeKeyboard());

      // ارسال به گروه (در صورت تنظیم)
      const groupMsg = `💡 ایده جدید:\n\nعنوان: ${ctx.wizard.state.idea.title}\nتوضیح: ${ctx.wizard.state.idea.description}\nاولویت: ${mapping[input]}\nثبت کننده: @${ctx.from.username || ctx.from.first_name}`;
      await sendToGroup(groupMsg, Markup.inlineKeyboard([[Markup.button.callback('👍 رأی', `vote_idea_${ideaId}`)]]));
    } catch (e) {
      console.error('createIdea error:', e);
      await ctx.reply('خطا در ثبت ایده. لطفاً بعداً تلاش کن.');
    } finally {
      ctx.wizard.state.idea = null;
      return ctx.scene.leave();
    }
  }
);

// -- Task Wizard (ایجاد تسک) --
const taskWizard = new WizardScene(
  'taskWizard',
  async (ctx) => {
    await ctx.reply('عنوان تسک رو وارد کن: (یا /cancel برای لغو)');
    ctx.wizard.state.task = {};
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      await ctx.reply('عنوان معتبر نیست.');
      return;
    }
    ctx.wizard.state.task.title = ctx.message.text.trim();
    await ctx.reply('توضیح کوتاه (یا "-" برای بی‌توضیح):');
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.task.description = (ctx.message && ctx.message.text) ? ctx.message.text.trim() : '';
    await ctx.reply('آی‌دی یا یوزرنیم کسی که میخوای تسک رو بهش بدی رو وارد کن (مثال: @username یا id):');
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      await ctx.reply('مقدار معتبر نیست.');
      return;
    }
    const assigneeRaw = ctx.message.text.trim();
    let assigneeId = null, assigneeUsername = null;

    if (assigneeRaw.startsWith('@')) {
      assigneeUsername = assigneeRaw.slice(1);
      const userRow = await db.getUserByUsername(assigneeUsername).catch(()=>null);
      if (userRow) assigneeId = userRow.user_id;
    } else if (/^\d+$/.test(assigneeRaw)) {
      assigneeId = Number(assigneeRaw);
      const u = await db.getUser(assigneeId).catch(()=>null);
      if (u) assigneeUsername = u.username;
    }

    ctx.wizard.state.task.assigneeId = assigneeId;
    ctx.wizard.state.task.assigneeUsername = assigneeUsername || assigneeRaw;
    await ctx.reply('مهلت (YYYY-MM-DD) یا "-" برای بدون مهلت:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const deadline = (ctx.message && ctx.message.text) ? ctx.message.text.trim() : null;
    const task = ctx.wizard.state.task;
    try {
      const taskId = await db.createTask(
        task.title,
        task.description === '-' ? '' : task.description,
        task.assigneeId,
        task.assigneeUsername,
        (deadline === '-' ? null : deadline),
        'ToDo',
        ctx.from.id,
        null
      );
      await ctx.reply(`تسک ساخته شد (ID: ${taskId})`);
      // notify assignee if we have numeric id
      if (task.assigneeId) {
        await bot.telegram.sendMessage(task.assigneeId, `📌 تسکی به شما اختصاص داده شد: ${task.title}`);
      }
      await sendToGroup(`🆕 تسک جدید: ${task.title}\nمسئول: ${task.assigneeUsername}`);
    } catch (e) {
      console.error('createTask error:', e);
      await ctx.reply('خطا در ایجاد تسک.');
    } finally {
      ctx.wizard.state.task = null;
      return ctx.scene.leave();
    }
  }
);

// -- Standup Wizard --
const standupWizard = new WizardScene(
  'standupWizard',
  async (ctx) => {
    ctx.wizard.state.standup = {};
    await ctx.reply('گزارش دیروزی (yesterday):');
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.standup.yesterday = ctx.message && ctx.message.text ? ctx.message.text : '';
    await ctx.reply('کار امروز (today):');
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.standup.today = ctx.message && ctx.message.text ? ctx.message.text : '';
    await ctx.reply('آیا بلاکر یا مانعی داری؟ (اگر نه بنویس: ندارم)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const blocker = ctx.message && ctx.message.text ? ctx.message.text : '';
    const s = ctx.wizard.state.standup;
    const today = new Date().toISOString().split('T')[0];
    try {
      await db.createStandup(ctx.from.id, today, s.yesterday, s.today, blocker);
      await db.addKarma(ctx.from.id, 5);
      await ctx.reply('استندآپ ثبت شد — 5 کارما اضافه شد!');

      if (blocker && blocker.trim() && blocker.trim() !== 'ندارم') {
        for (const adminId of ADMIN_USER_IDS) {
          await bot.telegram.sendMessage(adminId, `⚠️ بلاکر گزارش شده توسط @${ctx.from.username || ctx.from.first_name}:\n\n${blocker}`);
        }
      }
    } catch (e) {
      console.error('createStandup error:', e);
      await ctx.reply('خطا در ثبت استندآپ.');
    } finally {
      ctx.wizard.state.standup = null;
      return ctx.scene.leave();
    }
  }
);

// -- Poll Wizard (فقط ادمین) --
const pollWizard = new WizardScene(
  'pollWizard',
  async (ctx) => {
    if (!await isAdmin(ctx.from.id)) {
      await ctx.reply('شما ادمین نیستی و اجازه‌ی ساخت نظرسنجی نداری.');
      return ctx.scene.leave();
    }
    await ctx.reply('عنوان نظرسنجی را وارد کن:');
    ctx.wizard.state.poll = {};
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.poll.title = ctx.message && ctx.message.text ? ctx.message.text.trim() : '';
    await ctx.reply('گزینه‌ها را با کاما جدا کن (حداقل 2 گزینه):\nمثال: آ، ب، ج');
    return ctx.wizard.next();
  },
  async (ctx) => {
    try {
      const options = (ctx.message && ctx.message.text) ? ctx.message.text.split(',').map(s => s.trim()).filter(Boolean) : [];
      if (options.length < 2) {
        await ctx.reply('حداقل 2 گزینه لازم است. دوباره وارد کن:');
        return;
      }
      const pollId = await db.createPoll(ctx.wizard.state.poll.title, options, ctx.from.id);
      const buttons = options.map((opt, idx) => [Markup.button.callback(opt, `poll_vote_${pollId}_${idx}`)]);
      await sendToGroup(`📊 نظرسنجی جدید:\n\n${ctx.wizard.state.poll.title}`, Markup.inlineKeyboard(buttons));
      await ctx.reply('نظرسنجی ایجاد شد.');
    } catch (e) {
      console.error('createPoll error:', e);
      await ctx.reply('خطا در ایجاد نظرسنجی.');
    } finally {
      ctx.wizard.state.poll = null;
      return ctx.scene.leave();
    }
  }
);

// ---------- Stage ----------
const stage = new Stage([ideaWizard, taskWizard, standupWizard, pollWizard], { ttl: 10 * 60 * 1000 });
bot.use(stage.middleware());

// ---------- Command Handlers ----------

// /start
bot.start(async (ctx) => {
  try {
    await db.createUser(ctx.from.id, ctx.from.username || ctx.from.first_name || '');
    const user = await db.getUser(ctx.from.id);
    if (user && user.accepted_rules) {
      await ctx.reply(`سلام ${ctx.from.first_name} 👋\nخوش اومدی! برای راهنمایی /help رو بزن.`);
    } else {
      await ctx.reply(`سلام ${ctx.from.first_name} 👋\nخوش اومدی! قبل از استفاده قوانین رو قبول کن.`);
      const rules = `📋 قوانین تیم:\n1) احترام\n2) فعالیت منظم\n3) پیگیری تسک‌ها\nآیا قبول داری؟`;
      await ctx.reply(rules, Markup.inlineKeyboard([
        Markup.button.callback('✅ قبول می‌کنم', 'accept_rules'),
        Markup.button.callback('❌ قبول ندارم', 'reject_rules')
      ]));
    }
  } catch (e) {
    console.error('/start error:', e);
    await ctx.reply('خطا در پردازش /start');
  }
});

// /help
bot.help(async (ctx) => {
  const help = `
دستورات اصلی:
/idea - ثبت ایده
/ideas - مشاهده ایده‌ها
/task - ایجاد تسک
/mytasks - تسک‌های من
/standup - ثبت استندآپ
/poll - ایجاد نظرسنجی (ادمین)
/upload - آپلود فایل
/karma - مشاهده کارما
/help - راهنما
/cancel - لغو
  `.trim();
  await ctx.reply(help);
});

// /idea (شروع wizard)
bot.command('idea', (ctx) => ctx.scene.enter('ideaWizard'));

// /task
bot.command('task', (ctx) => ctx.scene.enter('taskWizard'));

// /standup
bot.command('standup', (ctx) => ctx.scene.enter('standupWizard'));

// /poll
bot.command('poll', (ctx) => ctx.scene.enter('pollWizard'));

// /ideas
bot.command('ideas', async (ctx) => {
  try {
    const ideas = await db.getAllIdeas(50, 0);
    if (!ideas || ideas.length === 0) {
      await ctx.reply('هیچ ایده‌ای ثبت نشده.');
      return;
    }
    let message = '💡 ایده‌ها:\n\n';
    ideas.forEach((idea, idx) => {
      message += `${idx+1}. ${idea.title} — توسط @${idea.username || 'ناشناس'} — رأی: ${idea.vote_count || 0}\n`;
    });
    await ctx.reply(message);
  } catch (e) {
    console.error('/ideas error:', e);
    await ctx.reply('خطا در گرفتن لیست ایده‌ها.');
  }
});

// /mytasks
bot.command('mytasks', async (ctx) => {
  try {
    const tasks = await db.getUserTasks(ctx.from.id);
    if (!tasks || tasks.length === 0) {
      await ctx.reply('هیچ تسکی برات پیدا نشد.');
      return;
    }
    let msg = '📋 تسک‌های شما:\n\n';
    tasks.forEach((t, i) => {
      msg += `${i+1}. ${t.title} — وضعیت: ${t.status} — مهلت: ${t.deadline || 'ندارد'}\n`;
    });
    await ctx.reply(msg);
  } catch (e) {
    console.error('/mytasks error:', e);
    await ctx.reply('خطا در دریافت تسک‌ها.');
  }
});

// /upload - راهنمای آپلود: کاربر فایل رو بفرسته
bot.command('upload', async (ctx) => {
  await ctx.reply('لطفاً فایل موردنظر رو ارسال کن. پس از ارسال، در پیام بعدی برچسب‌ها را وارد کن.');
  ctx.session.expectingFile = true;
});

// /karma
bot.command('karma', async (ctx) => {
  try {
    const karma = await db.getUserKarma(ctx.from.id);
    const top = await db.getTopUsersByKarma(5);
    let msg = `🏆 کارمای شما: ${karma}\n\nبرترین‌ها:\n`;
    top.forEach((u,i)=> { msg += `${i+1}. @${u.username||'ناشناس'} — ${u.karma}\n`; });
    await ctx.reply(msg);
  } catch (e) {
    console.error('/karma error:', e);
    await ctx.reply('خطا در دریافت کارما.');
  }
});

// /cancel
bot.command('cancel', async (ctx) => {
  ctx.session = {};
  await ctx.reply('عملیات لغو شد.', Markup.removeKeyboard());
  // leave scene if inside
  try { await ctx.scene.leave(); } catch (_) {}
});

// ---------- File handling ----------
bot.on('document', async (ctx) => {
  try {
    if (!ctx.message || !ctx.message.document) return;
    const doc = ctx.message.document;
    // ذخیره فایلID و نام در session و از کاربر انتظار تگ
    ctx.session.uploadingFile = { fileId: doc.file_id, fileName: doc.file_name || 'file' };
    await ctx.reply('فایل دریافت شد. لطفاً برچسب‌ها را برای فایل وارد کن (مثلاً: notes, pdf):');
  } catch (e) {
    console.error('document handler error:', e);
  }
});

// وقتی کاربر متن فرستاد و session.uploadingFile موجود باشه => ثبت فایل در DB
bot.on('text', async (ctx) => {
  try {
    // اگر در حال آپلود فایل باشیم، این پیام برچسب‌هاست
    if (ctx.session && ctx.session.uploadingFile) {
      const tags = ctx.message.text.trim();
      const { fileId, fileName } = ctx.session.uploadingFile;
      const savedId = await db.saveFile(ctx.from.id, fileId, fileName, tags);
      await ctx.reply(`فایل ذخیره شد (ID: ${savedId})`);
      // ارسال به گروه
      await sendToGroup(`📁 فایل جدید:\nنام: ${fileName}\nبرچسب‌ها: ${tags}\nآپلود شده توسط: @${ctx.from.username || ctx.from.first_name}`, Markup.inlineKeyboard([[Markup.button.callback('📥 دانلود', `download_${savedId}`)]]));
      delete ctx.session.uploadingFile;
      return;
    }
    // در غیر این صورت متن عادی — نادیده یا میتونی کامند سفارشی بذاری
  } catch (e) {
    console.error('text handler error:', e);
    await ctx.reply('خطا در پردازش پیام متن.');
  }
});

// ---------- Inline queries (جستجو) ----------
bot.on('inline_query', async (ctx) => {
  try {
    const q = ctx.inlineQuery && ctx.inlineQuery.query ? ctx.inlineQuery.query.trim() : '';
    if (!q) return;
    const results = await db.searchContent(q, 'all');
    const inline = (results || []).slice(0, 10).map((item, idx) => ({
      type: 'article',
      id: String(idx),
      title: item.title || (item.type + ' #' + item.id),
      description: (item.description || '').slice(0, 120),
      input_message_content: { message_text: `🔎 ${item.type.toUpperCase()}\n\n${item.title}\n\n${(item.description||'').slice(0,300)}` }
    }));
    await ctx.answerInlineQuery(inline);
  } catch (e) {
    console.error('inline_query error:', e);
  }
});

// ---------- Callback actions ----------

// قبول/رد قوانین
bot.action('accept_rules', async (ctx) => {
  try {
    await db.acceptRules(ctx.from.id);
    await ctx.editMessageText('✅ قوانین پذیرفته شد. خوش آمدی!');
    await ctx.answerCbQuery();
  } catch (e) {
    console.error('accept_rules error:', e);
    await ctx.answerCbQuery('خطا در پذیرش قوانین');
  }
});
bot.action('reject_rules', async (ctx) => {
  try {
    await ctx.editMessageText('❌ برای استفاده از ربات باید قوانین را بپذیرید.');
    await ctx.answerCbQuery();
  } catch (e) {
    console.error('reject_rules error:', e);
  }
});

// رأی به ایده: vote_idea_{id}
bot.action(/vote_idea_(\d+)/, async (ctx) => {
  try {
    const ideaId = Number((ctx.match && ctx.match[1]) || NaN);
    if (!ideaId) return await ctx.answerCbQuery('ایده مشخص نیست.');
    const voted = await db.voteForIdea(ctx.from.id, ideaId);
    if (voted) {
      await ctx.answerCbQuery('👍 رأی شما ثبت شد.');
      // (اختیاری) به‌روزرسانی پیام گروه یا ارسال تایید
    } else {
      await ctx.answerCbQuery('شما قبلاً رأی داده‌اید.');
    }
  } catch (e) {
    console.error('vote_idea error:', e);
    await ctx.answerCbQuery('خطا در ثبت رأی.');
  }
});

// دانلود فایل از طریق callback (download_{fileDbId})
bot.action(/download_(\d+)/, async (ctx) => {
  try {
    const fileDbId = Number(ctx.match && ctx.match[1]);
    if (!fileDbId) return await ctx.answerCbQuery('فایل پیدا نشد.');
    const rows = await db.getFilesByTag('', 100); // getFilesByTag نیست دقیق برای id؛ بهتر می‌تونیم متد جدید بسازیم اما فعلاً جستجو
    // بهتر: اگر DB متد getFileById داری یا اضافه کنی، ازش استفاده کن. اینجا تلاش ساده:
    const fileRow = (await db.all('SELECT * FROM files WHERE id = ?', [fileDbId])).shift();
    if (!fileRow) return await ctx.answerCbQuery('فایل در DB پیدا نشد.');
    // ارسال فایل با file_id تلگرام
    await bot.telegram.sendDocument(ctx.from.id, { source: await bot.telegram.getFileLink(fileRow.file_id_telegram) }).catch(async (_) => {
      // اگر getFileLink دردسر داشت، فقط اطلاع به کاربر:
      await ctx.reply('متاسفانه امکان ارسال فایل از سرور وجود ندارد. (فایل_id ذخیره شده در DB موجود است)');
    });
    await ctx.answerCbQuery();
  } catch (e) {
    console.error('download action error:', e);
    await ctx.answerCbQuery('خطا هنگام دانلود فایل.');
  }
});

// رأی در نظرسنجی: poll_vote_{pollId}_{optionIndex}
bot.action(/poll_vote_(\d+)_(\d+)/, async (ctx) => {
  try {
    const pollId = Number(ctx.match[1]);
    const idx = Number(ctx.match[2]);
    if (!pollId && pollId !== 0) return await ctx.answerCbQuery('نظرسنجی معتبر نیست.');
    const ok = await db.voteInPoll(pollId, ctx.from.id, idx);
    if (ok) {
      await ctx.answerCbQuery('رأی ثبت شد.');
    } else {
      await ctx.answerCbQuery('خطا در ثبت رأی.');
    }
  } catch (e) {
    console.error('poll_vote error:', e);
    await ctx.answerCbQuery('خطا در رأی‌گیری.');
  }
});

// ---------- Cron jobs ----------

// Standup reminder — اجرای هر روز در STANDUP_TIME
try {
  const [sh, sm] = STANDUP_TIME.split(':').map(Number);
  if (!isNaN(sh) && !isNaN(sm)) {
    cron.schedule(`${sm} ${sh} * * *`, async () => {
      try {
        const users = await db.getTopUsersByKarma(200); // users list quick
        for (const u of users) {
          try {
            await bot.telegram.sendMessage(u.user_id, `⏱ یادآوری استندآپ روزانه — لطفاً گزارش امروزت رو ثبت کن: /standup`);
          } catch (_) { /* ignore unreachable */ }
        }
        await sendToGroup('⏱ یادآوری: لطفاً استندآپ روزانه‌تون رو ثبت کنید.');
      } catch (e) { console.error('standup cron error:', e); }
    }, { timezone: 'Europe/Istanbul' });
  } else {
    console.warn('فرمت STANDUP_TIME اشتباه است؛ باید HH:MM باشد.');
  }
} catch (e) {
  console.error('cron schedule error:', e);
}

// Overdue checker — هر روز ساعت 09:00
cron.schedule('0 9 * * *', async () => {
  try {
    const overdue = await db.getOverdueTasks();
    for (const t of (overdue || [])) {
      await db.updateTaskStatus(t.id, 'Overdue');
      if (t.assignee_id) {
        await bot.telegram.sendMessage(t.assignee_id, `⚠️ تسک "${t.title}" به وضعیت Overdue تغییر کرد.`);
      }
      for (const adminId of ADMIN_USER_IDS) {
        try { await bot.telegram.sendMessage(adminId, `⚠️ تسک "${t.title}" overdue شد — مسئول: ${t.assignee_username}`); } catch(_) {}
      }
    }
  } catch (e) { console.error('overdue cron error:', e); }
}, { timezone: 'Europe/Istanbul' });

// ---------- Error handling ----------
bot.catch((err, ctx) => {
  console.error('BOT ERROR:', err);
  try {
    if (ctx && ctx.reply) ctx.reply('متاسفانه خطایی رخ داد. مدیر پروژه رو اطلاع بده.');
  } catch (_) {}
});

// ---------- Webhook / Express ----------
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Bot is running'));

let webhookSet = false;

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res).catch(e => {
    console.error('handleUpdate error:', e);
  });
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log(`Express listening on ${PORT} (env: ${NODE_ENV})`);
  if (NODE_ENV === 'production') {
    // set webhook if domain provided
    const domain = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
    if (domain) {
      try {
        await bot.telegram.setWebhook(`${domain}/bot${BOT_TOKEN}`);
        webhookSet = true;
        console.log('Webhook set:', `${domain}/bot${BOT_TOKEN}`);
      } catch (e) {
        console.error('setWebhook error:', e);
      }
    } else {
      console.warn('در حالت production اما WEBHOOK_URL تنظیم نشده — از polling استفاده خواهد شد.');
      if (NODE_ENV !== 'production') await bot.launch();
    }
  } else {
    // development -> polling
    try {
      await bot.launch();
      console.log('Bot launched (polling mode)');
    } catch (e) {
      console.error('bot.launch error:', e);
    }
  }
});

// ---------- Graceful shutdown ----------
const shutdown = async () => {
  try {
    console.log('Shutting down bot...');
    if (!webhookSet) {
      await bot.stop('SIGTERM');
    } else {
      try { await bot.telegram.deleteWebhook(); } catch(_) {}
    }
    db.close();
    process.exit(0);
  } catch (e) {
    console.error('shutdown error:', e);
    process.exit(1);
  }
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
