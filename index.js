/**
 * main2.js
 * Updated: added language selection for new users before subscription check,
 * fixed incorrect-language message issues by consistently using per-user i18n,
 * added a language keyboard with many languages (matching provided image).
 *
 * Usage:
 *   npm install telegraf i18next i18next-fs-backend pidusage bedrock-protocol minecraft-server-util
 *   BOT_TOKEN=your_token_here node main2.js
 *
 * Notes:
 * - i18next preload still only creates sample en/ar files; other languages will
 *   fallback to 'en' unless you add corresponding locales/*.json files.
 * - New users get language = null initially; after they press a language button,
 *   their language is saved and then subscription is checked and main menu shown.
 */

const { Telegraf, Markup, Scenes, session } = require('telegraf');
const os = require('os');
const pidusage = require('pidusage');
const bedrock = require('bedrock-protocol');
const { statusBedrock } = require('minecraft-server-util');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Replace telegraf-i18n with i18next
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');

// --- JSON Database Management ---
const dataDir = path.join(__dirname, 'data');

const dbLocks = new Map();

// Helper function to acquire a lock for a file
async function acquireLock(file) {
    while (dbLocks.get(file)) {
        await new Promise(resolve => setTimeout(resolve, 50)); // Wait if locked
    }
    dbLocks.set(file, true);
}

// Helper function to release a lock
function releaseLock(file) {
    dbLocks.delete(file);
}

// Helper function to read a JSON file
async function readDb(file) {
    await acquireLock(file);
    try {
        const filePath = path.join(dataDir, file);
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            if (file === 'users.json') return [];
            if (file === 'servers.json') return [];
            if (file === 'config.json') return {};
            if (file === 'versions.json') return [];
            return {};
        }
        // If JSON is invalid, return a default structure to prevent crash
        if (error instanceof SyntaxError) {
            console.error(`Syntax error in ${file}, returning default.`);
            if (file === 'users.json') return [];
            if (file === 'servers.json') return [];
            if (file === 'config.json') return {};
            if (file === 'versions.json') return [];
            return {};
        }
        console.error(`Error reading database file ${file}:`, error);
        throw error;
    } finally {
        releaseLock(file);
    }
}

// Helper function to write to a JSON file
async function writeDb(file, data) {
    await acquireLock(file);
    try {
        const filePath = path.join(dataDir, file);
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
        console.error(`Error writing to database file ${file}:`, error);
        throw error;
    } finally {
        releaseLock(file);
    }
}

// --- Caching Mechanism ---
const userCache = new Map(); // Cache for user status (banned, admin, language)
const subscriptionCache = new Map(); // Cache for channel subscription status

function getFromCache(cache, key) {
    const entry = cache.get(key);
    if (entry && entry.expiry > Date.now()) {
        return entry.value;
    }
    cache.delete(key); // Remove expired entry
    return null;
}

function setToCache(cache, key, value, ttl) { // ttl in seconds
    const expiry = Date.now() + ttl * 1000;
    cache.set(key, { value, expiry });
}
// --- End Caching Mechanism ---

async function checkUserSubscription(ctx, silent = false) {
    const userId = ctx.from.id;
    const cachedStatus = getFromCache(subscriptionCache, userId);
    if (cachedStatus !== null) {
        return cachedStatus;
    }

    const config = await readDb('config.json');
    const requiredChannels = config.requiredChannels || [];
    
    if (requiredChannels.length === 0) {
        setToCache(subscriptionCache, userId, true, 3600); // Cache for 1 hour if no channels
        return true;
    }

    const unsubscribed = [];

    for (const channel of requiredChannels) {
        try {
            const member = await ctx.telegram.getChatMember(channel, userId);
            if (['left', 'kicked'].includes(member.status)) {
                unsubscribed.push(channel);
            }
        } catch (err) {
            console.error(`Failed to check channel ${channel}:`, err.message);
            unsubscribed.push(channel);
        }
    }

    if (unsubscribed.length > 0) {
        if (!silent) {
            let msg = ctx.i18n.t('must_subscribe_intro') + '\n\n';
            msg += unsubscribed.map(ch => `- ${ch}`).join('\n');
            msg += '\n\n' + ctx.i18n.t('after_subscribe_press');

            try {
                await ctx.reply(msg, Markup.inlineKeyboard([
                    [Markup.button.callback(ctx.i18n.t('i_subscribed_button'), 'check_subscription')]
                ]));
            } catch (error) {
                if (error.code === 403) {
                    // User blocked the bot, skip silently
                } else {
                    console.error(`Error sending subscription message to ${userId}:`, error);
                }
            }
        }
        
        setToCache(subscriptionCache, userId, false, 300); // Cache for 5 minutes
        return false;
    }
    
    setToCache(subscriptionCache, userId, true, 300); // Cache for 5 minutes
    return true;
}


const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3001;
const BOT_TOKEN =  '8264016414:AAFA_6r6LOy6bFNDBd_QkIWOekUUSDhXJCg';
const ADMIN_ID = 7743455759;
const activeClients = new Map();

// ---------- i18next initialization ----------
async function initI18next() {
    const localesDir = path.join(__dirname, 'locales');
    // Ensure folder exists and create minimal files if missing (non-destructive)
    try {
        await fs.mkdir(localesDir, { recursive: true });
        const enPath = path.join(localesDir, 'en.json');
        const arPath = path.join(localesDir, 'ar.json');
        // create minimal samples if not exist
        try {
            await fs.access(enPath);
        } catch {
            await fs.writeFile(enPath, JSON.stringify({
                language_prompt: "Choose language:",
                language_changed: "Language changed to {{lang}}.",
                welcome: "Welcome, {{name}}!",
                hello: "Hello, {{name}}!",
                back_button: "Back",
                must_subscribe_intro: "Please subscribe to the required channels:",
                after_subscribe_press: "After subscribing press:",
                i_subscribed_button: "I subscribed",
                bot_under_maintenance: "Bot is under maintenance.",
                unexpected_error: "An unexpected error occurred.",
                checking: "Checking...",
                thanks_for_subscribing: "Thanks for subscribing!",
                subscribe_first: "Please subscribe first.",
                send_ip_prompt: "Send server IP:",
                send_port_prompt: "Send server Port:",
                cancel_button: "Cancel",
                operation_cancelled: "Operation cancelled.",
                send_broadcast_message: "Send the message to broadcast:",
                broadcast_choose_settings: "Choose broadcast settings:",
                pin_enabled: "📌 Pin enabled",
                pin_disabled: "📌 Pin disabled",
                send_button: "Send",
                broadcast_cancelled: "Broadcast cancelled.",
                broadcast_sending: "Broadcast is being sent...",
                broadcast_done: "Broadcast completed.",
                sent_to: "Sent to",
                failed: "Failed",
                pin_results: "Pin results",
                pinned: "Pinned",
                pin_failed: "Pin failed",
                send_channel_with_at: "Send channel like @channelname",
                channel_format_invalid: "Channel format invalid. Include @",
                channel_added: "Channel {{channel}} added.",
                channel_removed: "Channel {{channel}} removed.",
                manage_required_channels: "Manage required channels",
                current_channels: "Current channels:",
                no_required_channels: "No required channels set.",
                add_channel: "Add channel",
                remove_channel: "Remove channel",
                bot_disconnected: "Bot disconnected",
                check_plugin: "Please check the plugin.",
                server_not_found: "Server not found.",
                bot_already_running: "Bot already running",
                searching_server: "Searching for server...",
                unsupported_protocol: "Unsupported protocol {{protocol}}",
                server_found_and_starting: "Server found. Starting ({{version}})...",
                bot_now_active: "Bot now active: {{serverName}}",
                failed_connect: "Failed to connect.",
                bot_stopped: "Bot stopped.",
                manage_title: "Manage {{serverName}}",
                name_label: "Name",
                address_label: "Address",
                bot_name_label: "Bot name",
                status_label: "Status",
                send_version_name: "Send version name",
                protocol_must_be_number: "Protocol must be a number.",
                version_added: "Version added.",
                protocol_exists: "Protocol already exists.",
                unexpected_error_short: "Unexpected error.",
                how_to_use_text: "How to use the bot...",
                welcome_message: "Welcome, {{name}}!",
                my_servers: "My servers",
                add_server: "Add server",
                add_server_now: "Add server now",
                no_bedrock_servers: "No Bedrock servers.",
                choose_server: "Choose a server:",
                refresh: "Refresh",
                back_to_main: "Back to main",
                max_servers_reached: "Max servers reached.",
                server_already_added: "Server already added.",
                server_added_by_other: "Server already added by another user.",
                server_added_success: "Server {{name}} added successfully.",
                error_adding_server: "Error adding server.",
                server_deleted: "Server deleted.",
                server_info_title: "Server info - {{name}}",
                version_label: "Version",
                players_label: "Players",
                description_label: "Description",
                cannot_reach_server: "Cannot reach server.",
                confirm_delete_server: "Confirm delete server?",
                yes_delete: "Yes, delete",
                no_cancel: "No, cancel",
                deleting: "Deleting...",
                bot_not_active: "Bot not active.",
                uptime_text: "Uptime: {{hours}}h {{minutes}}m {{seconds}}s",
                fetching_info: "Fetching info...",
                fetching_list: "Fetching list...",
                manage_versions_title: "Manage versions",
                list_all: "List all",
                add_version: "Add version",
                delete_version: "Delete version",
                bedrock_label: "Bedrock",
                bot_settings_title: "Bot settings",
                bot_status: "Bot status",
                on: "On",
                off: "Off",
                bot_status_changed: "Bot status changed to {{status}}",
                stats: "Stats",
                broadcast_all: "Broadcast",
                manage_users: "Manage users",
                view_all_servers: "View servers",
                manage_versions: "Manage versions",
                manage_admins: "Manage admins",
                system_status: "System",
                back_button: "Back",
                admin_panel: "Admin panel",
                not_admin: "You are not an admin.",
                admin_only_button: "Admin only button.",
                send_user_id_for: "Send user ID for",
                cancel_hint: "Send /cancel to abort",
                ban_user: "Ban user",
                unban_user: "Unban user",
                info_user: "User info",
                invalid_id: "Invalid ID.",
                cannot_apply_to_main_dev: "Cannot apply to main developer.",
                user_not_found: "User not found.",
                user_banned: "User banned: {{username}}",
                user_unbanned: "User unbanned: {{username}}",
                user_info_header: "User Info",
                user_id_label: "User ID",
                username_label: "Username",
                is_admin_label: "Is admin",
                is_banned_label: "Is banned",
                joined_label: "Joined",
                servers_label: "Servers",
                delete_all_servers: "Delete all servers",
                yes_add: "Yes, add",
                cancel_button: "Cancel",
                broadcast_no_message: "No message to broadcast.",
                broadcast_cancelled: "Broadcast cancelled.",
                sending: "Sending..."
            }, null, 2), 'utf8');
        }
        try {
            await fs.access(arPath);
        } catch {
            await fs.writeFile(arPath, JSON.stringify({
                language_prompt: "اختر اللغة:",
                language_changed: "تم تغيير اللغة إلى {{lang}}.",
                welcome: "مرحبا، {{name}}!",
                hello: "مرحبا، {{name}}!",
                back_button: "رجوع",
                must_subscribe_intro: "يرجى الاشتراك في القنوات المطلوبة:",
                after_subscribe_press: "بعد الاشتراك اضغط:",
                i_subscribed_button: "اشتركت",
                bot_under_maintenance: "البوت تحت الصيانة.",
                unexpected_error: "حدث خطأ غير متوقع.",
                checking: "جارٍ التحقق...",
                thanks_for_subscribing: "شكراً لاشتراكك!",
                subscribe_first: "يرجى الاشتراك أولاً.",
                send_ip_prompt: "أرسل آي بي السيرفر:",
                send_port_prompt: "أرسل بورت السيرفر:",
                cancel_button: "إلغاء",
                operation_cancelled: "تم إلغاء العملية.",
                send_broadcast_message: "أرسل الرسالة للبث:",
                broadcast_choose_settings: "اختر إعدادات البث:",
                pin_enabled: "تثبيت مفعل",
                pin_disabled: "تثبيت معطل",
                send_button: "إرسال",
                broadcast_cancelled: "تم إلغاء البث.",
                broadcast_sending: "جارٍ إرسال البث...",
                broadcast_done: "اكتمل البث.",
                sent_to: "أرسلت إلى",
                failed: "فشل",
                pin_results: "نتائج التثبيت",
                pinned: "مثبت",
                pin_failed: "فشل التثبيت",
                send_channel_with_at: "أرسل القناة بصيغة @channel",
                channel_format_invalid: "صيغة القناة غير صحيحة. ضع @",
                channel_added: "تم إضافة القناة {{channel}}.",
                channel_removed: "تم حذف القناة {{channel}}.",
                manage_required_channels: "إدارة القنوات المطلوبة",
                current_channels: "القنوات الحالية:",
                no_required_channels: "لا توجد قنوات محددة.",
                add_channel: "أضف قناة",
                remove_channel: "احذف قناة",
                bot_disconnected: "تم فصل البوت",
                check_plugin: "يرجى التحقق من البلجن.",
                server_not_found: "لم يتم العثور على السيرفر.",
                bot_already_running: "البوت يعمل بالفعل",
                searching_server: "جارٍ البحث عن السيرفر...",
                unsupported_protocol: "بروتوكول غير مدعوم {{protocol}}",
                server_found_and_starting: "تم العثور على السيرفر. جاري التشغيل ({{version}})...",
                bot_now_active: "البوت الآن نشط: {{serverName}}",
                failed_connect: "فشل الاتصال.",
                bot_stopped: "تم إيقاف البوت.",
                manage_title: "إدارة {{serverName}}",
                name_label: "الاسم",
                address_label: "العنوان",
                bot_name_label: "اسم البوت",
                status_label: "الحالة",
                send_version_name: "أرسل اسم الإصدار",
                protocol_must_be_number: "بروتوكول يجب أن يكون رقم.",
                version_added: "تم إضافة الإصدار.",
                protocol_exists: "البروتوكول موجود مسبقاً.",
                unexpected_error_short: "خطأ غير متوقع.",
                how_to_use_text: "كيفية استخدام البوت...",
                welcome_message: "مرحبا، {{name}}!",
                my_servers: "سيرفراتي",
                add_server: "أضف سيرفر",
                add_server_now: "أضف سيرفر الآن",
                no_bedrock_servers: "لا توجد سيرفرات Bedrock.",
                choose_server: "اختر سيرفر:",
                refresh: "تحديث",
                back_to_main: "العودة",
                max_servers_reached: "تم الوصول للحد الأقصى من السيرفرات.",
                server_already_added: "السيرفر مضاف مسبقاً.",
                server_added_by_other: "السيرفر مضاف من قبل مستخدم آخر.",
                server_added_success: "تم إضافة {{name}} بنجاح.",
                error_adding_server: "خطأ أثناء إضافة السيرفر.",
                server_deleted: "تم حذف السيرفر.",
                server_info_title: "معلومات السيرفر - {{name}}",
                version_label: "الإصدار",
                players_label: "اللاعبون",
                description_label: "الوصف",
                cannot_reach_server: "لا يمكن الوصول للسيرفر.",
                confirm_delete_server: "هل تريد حذف السيرفر؟",
                yes_delete: "نعم احذف",
                no_cancel: "لا إلغاء",
                deleting: "جارٍ الحذف...",
                bot_not_active: "البوت غير نشط.",
                uptime_text: "مدة التشغيل: {{hours}}ساعة {{minutes}}د {{seconds}}ث",
                fetching_info: "جاري جلب المعلومات...",
                fetching_list: "جاري جلب القائمة...",
                manage_versions_title: "إدارة الإصدارات",
                list_all: "قائمة",
                add_version: "أضف إصدار",
                delete_version: "احذف إصدار",
                bedrock_label: "Bedrock",
                bot_settings_title: "إعدادات البوت",
                bot_status: "حالة البوت",
                on: "مفعل",
                off: "معطل",
                bot_status_changed: "تغيرت حالة البوت إلى {{status}}",
                stats: "إحصائيات",
                broadcast_all: "بث",
                manage_users: "إدارة المستخدمين",
                view_all_servers: "عرض السيرفرات",
                manage_versions: "إدارة الإصدارات",
                manage_admins: "إدارة المدراء",
                system_status: "النظام",
                back_button: "رجوع",
                admin_panel: "لوحة الأدمن",
                not_admin: "أنت لست أدمن.",
                admin_only_button: "زر للأدمن فقط.",
                send_user_id_for: "أرسل آي دي المستخدم لـ",
                cancel_hint: "أرسل /cancel للإلغاء",
                ban_user: "حظر المستخدم",
                unban_user: "إلغاء الحظر",
                info_user: "معلومات المستخدم",
                invalid_id: "آي دي غير صالح.",
                cannot_apply_to_main_dev: "لا يمكن تطبيق ذلك على مطور الرئيسي.",
                user_not_found: "المستخدم غير موجود.",
                user_banned: "تم حظر المستخدم: {{username}}",
                user_unbanned: "تم رفع الحظر عن: {{username}}",
                user_info_header: "معلومات المستخدم",
                user_id_label: "آي دي المستخدم",
                username_label: "اسم المستخدم",
                is_admin_label: "أدمن؟",
                is_banned_label: "محظور؟",
                joined_label: "انضم:",
                servers_label: "سيرفرات",
                delete_all_servers: "حذف كل السيرفرات",
                yes_add: "نعم أضف",
                cancel_button: "إلغاء",
                broadcast_no_message: "لا يوجد رسالة للبث.",
                broadcast_cancelled: "تم إلغاء البث.",
                sending: "جارٍ الإرسال..."
            }, null, 2), 'utf8');
        }
    } catch (e) {
        console.error('Failed creating locales folder or sample files:', e);
    }

    await i18next
        .use(Backend)
        .init({
            initImmediate: false,
            fallbackLng: 'en',
            preload: ['en', 'ar'],
            backend: {
                loadPath: path.join(__dirname, 'locales/{{lng}}.json'),
            },
            interpolation: { escapeValue: false }
        });
}

// alias to keep many references in code (i18n.t(...))
const i18n = i18next;

// --- Data Models (using JSON files) ---

const Users = {
    async find() {
        return await readDb('users.json');
    },
    async findOne(query) {
        const users = await this.find();
        return users.find(u => Object.keys(query).every(key => u[key] === query[key])) || null;
    },
    async create(userData) {
        const users = await this.find();
        const newUser = {
            ...userData,
            isBanned: false,
            isAdmin: userData.userId === ADMIN_ID,
            joinedAt: new Date().toISOString(),
            // Important: don't force 'en' here; leave null so we can ask user to choose language
            language: (userData.language === undefined ? null : userData.language)
        };
        users.push(newUser);
        await writeDb('users.json', users);
        return newUser;
    },
    async updateOne(query, update) {
        let users = await this.find();
        const userIndex = users.findIndex(u => Object.keys(query).every(key => u[key] === query[key]));
        if (userIndex !== -1) {
            const operation = Object.keys(update)[0]; // $set, $addToSet etc.
            const payload = update[operation];
            users[userIndex] = { ...users[userIndex], ...payload };
            await writeDb('users.json', users);
        }
    },
    async countDocuments(query = {}) {
        const users = await this.find();
        if (Object.keys(query).length === 0) return users.length;
        return users.filter(u => Object.keys(query).every(key => u[key] === query[key])).length;
    }
};

const Servers = {
    async find(query = {}) {
        const servers = await readDb('servers.json');
        if (Object.keys(query).length === 0) return servers;
        return servers.filter(s => Object.keys(query).every(key => s[key] === query[key]));
    },
    async findById(id) {
        const servers = await this.find();
        return servers.find(s => s._id === id) || null;
    },
    async findOne(query) {
        const servers = await this.find();
        return servers.find(s => Object.keys(query).every(key => s[key] === query[key])) || null;
    },
    async create(serverData) {
        const servers = await this.find();
        const newServer = {
            _id: crypto.randomBytes(12).toString('hex'), // Generate a unique ID
            ...serverData,
            status: 'متوقف',
            notifyOnError: true,
            autoRestart: false,
            botName: 'MaxBlack'
        };
        servers.push(newServer);
        await writeDb('servers.json', servers);
        return newServer;
    },
    async updateOne(query, update) {
        let servers = await this.find();
        const serverIndex = servers.findIndex(s => s._id === query._id);
        if (serverIndex !== -1) {
            const operation = Object.keys(update)[0]; // $set
            const payload = update[operation];
            servers[serverIndex] = { ...servers[serverIndex], ...payload };
            await writeDb('servers.json', servers);
        }
    },
    async deleteOne(query) {
        let servers = await this.find();
        const initialLength = servers.length;
        servers = servers.filter(s => !Object.keys(query).every(key => s[key] === query[key]));
        if (servers.length < initialLength) {
            await writeDb('servers.json', servers);
            return { deletedCount: 1 };
        }
        return { deletedCount: 0 };
    },
    async countDocuments(query = {}) {
        const servers = await this.find();
        if (Object.keys(query).length === 0) return servers.length;
        return servers.filter(s => Object.keys(query).every(key => s[key] === query[key])).length;
    }
};

const Config = {
    async findOne(query) {
        const config = await readDb('config.json');
        return { key: query.key, value: config[query.key] };
    },
    async updateOne(query, update, options = {}) {
        let config = await readDb('config.json');
        const key = query.key;
        if (update.$set) {
            config[key] = update.$set.value;
        } else if (update.$addToSet) {
            if (!config[key]) config[key] = [];
            const valueToAdd = update.$addToSet.value;
            if (!config[key].includes(valueToAdd)) {
                config[key].push(valueToAdd);
            }
        } else if (update.$pull) {
            if (config[key]) {
                config[key] = config[key].filter(item => item !== update.$pull.value);
            }
        } else if (update.$setOnInsert && options.upsert) {
            if (config[key] === undefined) {
                config[key] = update.$setOnInsert.value;
            }
        }
        await writeDb('config.json', config);
    }
};

const Versions = {
    async find(query = {}) {
        const versions = await readDb('versions.json');
        if (Object.keys(query).length === 0) return versions;
        return versions.filter(v => Object.keys(query).every(key => v[key] === query[key]));
    },
    async create(versionData) {
        let versions = await this.find();
        // Check for duplicates
        const exists = versions.some(v => v.protocol === versionData.protocol && v.type === versionData.type);
        if (exists) {
            const error = new Error('Duplicate key');
            error.code = 11000;
            throw error;
        }
        versions.push(versionData);
        await writeDb('versions.json', versions);
    },
    async deleteOne(query) {
        let versions = await this.find();
        const initialLength = versions.length;
        versions = versions.filter(v => !Object.keys(query).every(key => v[key] === query[key]));
        if (versions.length < initialLength) {
            await writeDb('versions.json', versions);
            return { deletedCount: 1 };
        }
        return { deletedCount: 0 };
    },
    async countDocuments() {
        const versions = await this.find();
        return versions.length;
    }
};


async function setupInitialConfig() {
    // Ensure data directory exists
    await fs.mkdir(dataDir, { recursive: true });

    // Set Admin
    let users = await readDb('users.json');
    let admin = users.find(u => u.userId === ADMIN_ID);
    if (admin) {
        if (!admin.isAdmin) {
            admin.isAdmin = true;
            await writeDb('users.json', users);
        }
    } else {
        users.push({ userId: ADMIN_ID, username: 'Admin', isBanned: false, isAdmin: true, joinedAt: new Date().toISOString(), language: 'en' });
        await writeDb('users.json', users);
    }

    // Set default config
    let config = await readDb('config.json');
    const defaults = {
        botOnline: true,
        adminNotifications: false,
        requiredChannels: []
    };
    let configUpdated = false;
    for (const key in defaults) {
        if (config[key] === undefined) {
            config[key] = defaults[key];
            configUpdated = true;
        }
    }
    if (configUpdated) {
        await writeDb('config.json', config);
    }

    // Populate versions if empty
    const versionsCount = await Versions.countDocuments();
    if (versionsCount === 0) {
        const BEDROCK_VERSIONS = { 827: '1.21.100', 818: '1.21.90', 800: '1.21.80', 786: '1.21.70', 776: '1.21.60', 766: '1.21.50', 748: '1.21.42', 729: '1.21.30', 712: '1.21.20', 686: '1.21.2', 685: '1.21.0', 671: '1.20.80', 662: '1.20.71', 649: '1.20.61', 630: '1.20.50', 622: '1.20.40', 618: '1.20.30', 594: '1.20.10', 589: '1.20.0', 582: '1.19.80', 575: '1.19.70', 568: '1.19.63', 560: '1.19.50', 554: '1.19.30', 544: '1.19.20', 527: '1.19.1', 503: '1.18.30', 475: '1.18.0', 448: '1.17.10', 422: '1.16.201' };

        const versionDocs = [];
        for (const protocol in BEDROCK_VERSIONS) {
            versionDocs.push({ type: 'bedrock', protocol: parseInt(protocol), name: BEDROCK_VERSIONS[protocol] });
        }
        await writeDb('versions.json', versionDocs);
        console.log('✅ Database initialized with', Object.keys(BEDROCK_VERSIONS).length, 'Minecraft Bedrock versions');
    }
}


async function reorderServers(userId) {
    // Fix: previously this function replaced the entire servers.json with only the given user's servers,
    // causing all other users' servers to be lost. Now we load all servers, update only this user's servers,
    // and write back the merged array.
    const allServers = await Servers.find(); // all servers
    const userServers = allServers.filter(s => s.userId === userId);

    // Sort user's servers (by _id as before) and reassign names
    userServers.sort((a, b) => a._id.localeCompare(b._id));
    for (let i = 0; i < userServers.length; i++) {
        userServers[i].serverName = `S - ${i + 1}`;
    }

    // Merge back: keep other users' servers intact
    const otherServers = allServers.filter(s => s.userId !== userId);
    const merged = otherServers.concat(userServers);

    // Optionally you can keep a stable sort overall; here we preserve other servers first then user's updated ones.
    await writeDb('servers.json', merged);
}


async function getSupportedVersions() {
    const versions = await Versions.find();
    const protocolMap = { bedrock: {}, java: {} }; // خلي الاثنين موجودين

    versions.forEach(v => {
        if (!protocolMap[v.type]) {
            protocolMap[v.type] = {}; // إذا النوع مو معرف يضيفه
        }
        protocolMap[v.type][v.protocol] = v.name;
    });

    return protocolMap;
}

async function startBot(ctx, serverId) {
    const server = await Servers.findById(serverId);
    if (!server) {
        try {
            await ctx?.editMessageText(ctx.i18n.t('server_not_found'));
        } catch (e) { /* ignore */ }
        return;
    }


    const clientIdentifier = server._id.toString();
    if (activeClients.has(clientIdentifier)) {
        try {
            await ctx?.editMessageText(ctx.i18n.t('bot_already_running'));
        } catch (e) { /* ignore */ }
        return;
    }

    await Servers.updateOne({ _id: server._id }, { $set: { status: 'جاري البحث...' } });
    try {
        await ctx?.editMessageText(ctx.i18n.t('searching_server', { type: server.serverType.toUpperCase() }));
    } catch (e) { /* ignore */ }

    const versions = await getSupportedVersions();
    const botFunctions = {
        bedrock: startBedrockBot,
    };
    botFunctions[server.serverType](ctx, server, versions);
}



async function startBedrockBot(ctx, server, versions) {
    const clientIdentifier = server._id.toString();
    try {
        const response = await statusBedrock(server.ip, server.port, { timeout: 8000 });
        const protocolVersion = response.version.protocol;
        const mcVersion = versions.bedrock[protocolVersion];

        if (!mcVersion) {
            await Servers.updateOne({ _id: server._id }, { $set: { status: 'إصدار غير مدعوم' } });
            try {
                await ctx?.editMessageText(ctx.i18n.t('unsupported_protocol', { protocol: protocolVersion }));
            } catch (e) { /* ignore */ }
            return;
        }
        
        await Servers.updateOne({ _id: server._id }, { $set: { status: 'جاري الاتصال...' } });
        if (ctx) {
            try {
                await ctx.editMessageText(ctx.i18n.t('server_found_and_starting', { version: response.version.name }));
            } catch (e) {
                if (!(e.response && e.response.description && e.response.description.includes('message is not modified'))) {
                    console.error('Error editing message in startBedrockBot (server found):', e);
                }
            }
        }

        const client = bedrock.createClient({
            host: server.ip,
            port: server.port,
            username: server.botName,
            version: mcVersion,
            offline: true,
        });

        // Key by serverId (consistent with other parts of the code)
        activeClients.set(clientIdentifier, { 
         client: client, 
         type: 'bedrock', 
         serverId: server._id,
        startTime: Date.now()   // ← أضف هذا السطر
  });

        const handleDisconnect = async (reason) => {
            console.log(`⚠️ Bot disconnected from ${server.serverName}. Reason: ${reason}`);
            activeClients.delete(clientIdentifier);
            client.removeAllListeners();

            const currentServer = await Servers.findById(server._id);
            if (currentServer && currentServer.autoRestart) {
                console.log(`🔄 Auto-restarting bot for ${server.serverName} in 30 seconds...`);
                await Servers.updateOne({ _id: currentServer._id }, { $set: { status: 'إعادة الاتصال...' } });
                setTimeout(() => startBedrockBot(null, currentServer, versions), 30000);
            } else {
                await Servers.updateOne({ _id: server._id }, { $set: { status: 'متوقف' } });
            }

            // Send notification to user using user's preferred language (we may not have ctx)
            try {
                const user = await Users.findOne({ userId: server.userId });
                const t = user ? i18n.getFixedT(user.language || 'en') : i18n.getFixedT('en');
                await bot.telegram.sendMessage(
                    server.userId,
                    `🔌 ${t('bot_disconnected')} ${server.serverName}.\n${t('check_plugin')}`
                ).catch(console.error);
            } catch (e) {
                console.error('Failed sending disconnect message to owner:', e);
            }
        };
        
        client.on('spawn', async () => { 
            console.log(`✅ ${server.serverType} bot connected: ${server.serverName} (${server.ip}:${server.port})`);
            await Servers.updateOne({ _id: server._id }, { $set: { status: 'نشط' } });
            
            if (ctx) {
                try {
                    await ctx.editMessageText(ctx.i18n.t('bot_now_active', { serverName: server.serverName }), { reply_markup: undefined });
                } catch(e) { /* ignore */ }

                setTimeout(async () => {
                    try {
                        const updatedServer = await Servers.findById(server._id);
                        const menu = getManageServerMenu(updatedServer);
                        if (menu) {
                            await ctx.editMessageText(menu.text, menu.options);
                        }
                    } catch(e) { /* ignore */ }
                }, 3000);
            }
        });

        client.on('disconnect', (packet) => handleDisconnect(packet.reason || 'فُصِلَ من السيرفر'));
        client.on('error', (err) => handleDisconnect(err.message));

    } catch (error) {
        console.error(`❌ Bedrock connection error (${server.serverName}):`, error.message);
        activeClients.delete(clientIdentifier);
        await Servers.updateOne({ _id: server._id }, { $set: { status: 'فشل الاتصال' } });
        try {
            await ctx?.editMessageText(
                ctx.i18n.t('failed_connect')
            );
        } catch (e) { /* ignore */ }
    }
}

async function manageServerAction(ctx, serverId) {
    const server = await Servers.findById(serverId);
    const menu = getManageServerMenu(server);

    if (menu) {
        try {
            await ctx.editMessageText(menu.text, menu.options);
        } catch (e) {
            if (!(e.response && e.response.description.includes('message is not modified'))) {
                 console.error("Error in manageServerAction:", e.message);
            }
        }
    } else {
        try {
            await ctx.editMessageText(ctx.i18n.t('server_not_found'));
        } catch (e) { /* ignore */ }
    }
}

async function stopBot(ctx, serverId) {
    const server = await Servers.findById(serverId);
    if (!server) {
        try {
            await ctx.editMessageText(ctx.i18n.t('server_not_found'));
        } catch (e) { /* ignore */ }
        return;
    }

    await Servers.updateOne({ _id: server._id }, { $set: { status: 'متوقف', autoRestart: false } });

    const clientIdentifier = server._id.toString();
    if (activeClients.has(clientIdentifier)) {
        const botInfo = activeClients.get(clientIdentifier);
        if (botInfo.type === 'java') {
            botInfo.client.quit();
        } else {
            botInfo.client.disconnect();
        }
        activeClients.delete(clientIdentifier);
    }
    
    try {
        await ctx.answerCbQuery(ctx.i18n.t('bot_stopped'));
    } catch (e) { /* ignore */ }
    await manageServerAction(ctx, serverId);
}

function getManageServerMenu(server) {
    if (!server) return null;

    const statusIcon = server.status === 'نشط' ? '🟢' : (server.status === 'متوقف' ? '🔴' : '🟡');
    const text = `${ctxSafeText('manage_title', { serverName: server.serverName })}\n` + 
             `----------------------------------------\n` + 
             `🏷️ ${ctxSafeText('name_label')}: ${server.serverName}\n` + 
             `🌐 ${ctxSafeText('address_label')}: ${server.ip}:${server.port}\n` + 
             `🤖 ${ctxSafeText('bot_name_label')}: ${server.botName}\n` + 
             `📊 ${ctxSafeText('status_label')}: ${statusIcon} ${server.status}`;

    const keyboard = Markup.inlineKeyboard([
        server.status === 'نشط'
            ? [Markup.button.callback('⏹ إيقاف البوت', `stop_bot:${server._id}`)]
            : [Markup.button.callback('▶️ تشغيل البوت', `start_bot:${server._id}`)],
        [
            Markup.button.callback('ℹ️ معلومات حية', `info_server:${server._id}`),
            Markup.button.callback('✏️ تغيير اسم البوت', `rename_bot:${server._id}`)
        ],
        
        [
            Markup.button.callback('⏱ مدة التشغيل', `uptime_server:${server._id}`) // 🆕 زر جديد
        ],
        
        [
            Markup.button.callback(`🔔 الإشعارات: ${server.notifyOnError ? 'مفعلة' : 'معطلة'}`, `toggle_notify:${server._id}`),
            Markup.button.callback(`🔄 التشغيل التلقائي: ${server.autoRestart ? 'مفعل' : 'معطل'}`, `toggle_autorestart:${server._id}`)
        ],
        [Markup.button.callback('🗑 حذف السيرفر', `delete_confirm:${server._id}`)],
        [Markup.button.callback('🔙 رجوع لسيرفراتي', 'my_servers')]
    ]);

    return { text, options: { ...keyboard } };
}

// ctxSafeText: helper to get translation where ctx may not be available (some callbacks)
// It will try to get translation using a default locale (en) if ctx is not present.
function ctxSafeText(key, params = {}) {
    try {
        // use i18next directly with fallback
        return i18n.t(key, params);
    } catch (e) {
        return key;
    }
}

const addServerWizard = new Scenes.WizardScene(
    'add-server-wizard',
    // Step 1: Ask for IP
    async (ctx) => {
        ctx.wizard.state.messages = [];
        ctx.wizard.state.serverData = { type: 'bedrock' }; // Set type directly
        try {
            const sentMessage = await ctx.reply(ctx.i18n.t('send_ip_prompt'), Markup.inlineKeyboard([
                [Markup.button.callback(ctx.i18n.t('cancel_button'), 'cancel_wizard')]
            ]));
            ctx.wizard.state.messages.push(sentMessage.message_id);
        } catch (e) {
            console.error("Error in add-server-wizard step 1:", e.message);
        }
        return ctx.wizard.next();
    },
    // Step 2: Ask for Port
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_wizard') {
             try {
                await ctx.deleteMessage();
             } catch (e) { /* ignore */ }
             try {
                await ctx.reply(ctx.i18n.t('operation_cancelled'));
             } catch (e) { /* ignore */ }
             await ctx.scene.leave();
             return sendMainMenu(ctx);
        }
        if (!ctx.message?.text) return;
        if (ctx.message.text === '/start') {
            await ctx.scene.leave();
            return sendMainMenu(ctx);
        }
        // If it's not /start, then process as IP
        ctx.wizard.state.serverData.ip = ctx.message.text.trim();
        // Automatically generate a server name
        const serverCount = await Servers.countDocuments({ userId: ctx.from.id });
        ctx.wizard.state.serverData.name = `S - ${serverCount + 1}`;
        try {
            await ctx.deleteMessage(ctx.message.message_id);
            await ctx.deleteMessage(ctx.wizard.state.messages.pop());
        } catch (e) { /* ignore */ }
        try {
            const sentMessage = await ctx.reply(ctx.i18n.t('send_port_prompt'), Markup.inlineKeyboard([
                [Markup.button.callback(ctx.i18n.t('cancel_button'), 'cancel_wizard')] 
            ]));
            ctx.wizard.state.messages.push(sentMessage.message_id);
        } catch (e) {
            console.error("Error in add-server-wizard step 2:", e.message);
        }
        return ctx.wizard.next();
    },
    // Step 3: Save server
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_wizard') {
            try {
                await ctx.deleteMessage();
            } catch (e) { /* ignore */ }
            try {
                await ctx.reply(ctx.i18n.t('operation_cancelled'));
            } catch (e) { /* ignore */ }
            await ctx.scene.leave();
            return sendMainMenu(ctx);
        }
        if (!ctx.message?.text) return;
        ctx.wizard.state.serverData.port = parseInt(ctx.message.text.trim());

        if (isNaN(ctx.wizard.state.serverData.port)) {
            await ctx.reply(ctx.i18n.t('port_must_be_number'));
            return;
        }

        try {
            await ctx.deleteMessage(ctx.message.message_id);
            await ctx.deleteMessage(ctx.wizard.state.messages.pop());
        } catch (e) { /* ignore */ }

        try {
            const serverCount = await Servers.countDocuments({ userId: ctx.from.id });
            if (serverCount >= 3) {
                await ctx.editMessageText(ctx.i18n.t('max_servers_reached'), Markup.inlineKeyboard([
                    [Markup.button.callback(ctx.i18n.t('back_to_main'), 'main_menu')]
                ]));
                return ctx.scene.leave();
            }

            const duplicateOwn = await Servers.findOne({
                ip: ctx.wizard.state.serverData.ip,
                port: ctx.wizard.state.serverData.port,
                userId: ctx.from.id
            });
            if (duplicateOwn) {
                await ctx.reply(ctx.i18n.t('server_already_added'));
                await ctx.scene.leave();
                return sendMainMenu(ctx);
            }

            const duplicateOther = await Servers.findOne({
                ip: ctx.wizard.state.serverData.ip,
                port: ctx.wizard.state.serverData.port,
            });
            if (duplicateOther) {
                await ctx.reply(ctx.i18n.t('server_added_by_other'));
                await ctx.scene.leave();
                return sendMainMenu(ctx);
            }

            const newServer = await Servers.create({
                userId: ctx.from.id,
                serverName: ctx.wizard.state.serverData.name,
                serverType: ctx.wizard.state.serverData.type,
                ip: ctx.wizard.state.serverData.ip,
                port: ctx.wizard.state.serverData.port
            });
          
            await reorderServers(ctx.from.id);
            await ctx.scene.leave();

            const successMsg = await ctx.reply(ctx.i18n.t('server_added_success', { name: newServer.serverName }));

            setTimeout(async () => {
                try {
                    await ctx.deleteMessage(successMsg.message_id);
                    const menu = getManageServerMenu(newServer);
                    if (menu) {
                        await ctx.reply(menu.text, menu.options);
                    }
                } catch (e) { /* ignore */ }
            }, 3000);

        } catch (error) {
            console.error('خطأ أثناء إضافة السيرفر:', error.message);
            try {
                await ctx.reply(ctx.i18n.t('error_adding_server'));
            } catch (e) { /* ignore */ }
            await ctx.scene.leave();
            return sendMainMenu(ctx);
        }
    }
);

addServerWizard.action('cancel_wizard', async (ctx) => {
    try {
        await ctx.deleteMessage();
        await ctx.reply(ctx.i18n.t('operation_cancelled'));
    } catch (e) { /* ignore */ }
    await ctx.scene.leave();
    return sendMainMenu(ctx);
});

const renameBotScene = new Scenes.BaseScene('rename-bot-scene');
renameBotScene.enter(async (ctx) => {
    try {
        ctx.scene.state.serverId = ctx.match[1];
        const prompt = await ctx.editMessageText(ctx.i18n.t('rename_warn'), { reply_markup: undefined });
        ctx.scene.state.messageToEdit = prompt.message_id;
    } catch (e) {
        console.error("Error entering rename scene:", e);
        try {
            await ctx.reply(ctx.i18n.t('try_again'));
        } catch (e) { /* ignore */ }
        await ctx.scene.leave();
    }
});

renameBotScene.on('text', async (ctx) => {
    try {
        await ctx.deleteMessage(ctx.message.id);
    } catch (e) { /* ignore */ }
    const messageToEdit = ctx.scene.state.messageToEdit;

    if (!messageToEdit) {
        try {
            await ctx.reply(ctx.i18n.t('session_expired'));
        } catch (e) { /* ignore */ }
        return ctx.scene.leave();
    }
    
    if (ctx.message.text === '/cancel') {
        try {
            await ctx.telegram.editMessageText(ctx.chat.id, messageToEdit, undefined, ctx.i18n.t('operation_cancelled'));
            setTimeout(() => ctx.deleteMessage(messageToEdit).catch(() => {}), 3000);
        } catch (e) { /* ignore */ }
        return ctx.scene.leave();
    }

    const newName = ctx.message.text.trim();
    const serverId = ctx.scene.state.serverId;
    await Servers.updateOne({ _id: serverId }, { $set: { botName: newName } });
    await ctx.scene.leave();

    try {
        await ctx.telegram.editMessageText(ctx.chat.id, messageToEdit, undefined, ctx.i18n.t('bot_name_changed', { name: newName }));
    } catch (e) { /* ignore */ }

    setTimeout(async () => {
        try {
            const updatedServer = await Servers.findById(serverId);
            const menu = getManageServerMenu(updatedServer);
            if (menu) {
                await ctx.telegram.editMessageText(ctx.chat.id, messageToEdit, undefined, menu.text, menu.options);
            }
        } catch (e) { /* ignore */ }
    }, 3000);
});
const addChannelScene = new Scenes.BaseScene('admin-add-channel-scene');
addChannelScene.enter((ctx) => ctx.reply(ctx.i18n.t('send_channel_with_at')).catch(console.error));
addChannelScene.on('text', async (ctx) => {
    if (ctx.message.text === '/cancel') {
        await ctx.scene.leave();
        return ctx.reply(ctx.i18n.t('operation_cancelled')).catch(console.error);
    }
    const channelName = ctx.message.text.trim();
    if (!channelName.startsWith('@')) {
        return ctx.reply(ctx.i18n.t('channel_format_invalid')).catch(console.error);
    }

    await Config.updateOne(
        { key: 'requiredChannels' },
        { $addToSet: { value: channelName } }, 
        { upsert: true }
    );
    subscriptionCache.clear(); // Invalidate cache
    await ctx.reply(ctx.i18n.t('channel_added', { channel: channelName })).catch(console.error);
    await ctx.scene.leave();
    ctx.update.callback_query = { data: 'admin_channels' };
    await bot.handleUpdate(ctx.update);
});
const removeChannelScene = new Scenes.BaseScene('admin-remove-channel-scene');
removeChannelScene.enter((ctx) => ctx.reply(ctx.i18n.t('send_channel_to_delete')).catch(console.error));
removeChannelScene.on('text', async (ctx) => {
    if (ctx.message.text === '/cancel') {
        await ctx.scene.leave();
        return ctx.reply(ctx.i18n.t('operation_cancelled')).catch(console.error);
    }
    const channelName = ctx.message.text.trim();

    await Config.updateOne(
        { key: 'requiredChannels' },
        { $pull: { value: channelName } } 
    );
    subscriptionCache.clear(); // Invalidate cache
    await ctx.reply(ctx.i18n.t('channel_removed', { channel: channelName })).catch(console.error);
    
    await ctx.scene.leave();
    ctx.update.callback_query = { data: 'admin_channels' };
    await bot.handleUpdate(ctx.update);
});
async function showAllServers(ctx, page = 1) {
    const PAGE_SIZE = 8; 
    try {
        await ctx.answerCbQuery();
    } catch (e) { /* ignore */ }

    const allServers = await Servers.find();
    const totalServers = allServers.length;
    const totalPages = Math.ceil(totalServers / PAGE_SIZE);
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const servers = allServers
        .sort((a, b) => (a._id < b._id ? 1 : -1)) // Sort descending by ID
        .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    if (totalServers === 0) {
        try {
            await ctx.editMessageText(ctx.i18n.t('no_servers_registered'), Markup.inlineKeyboard([
                [Markup.button.callback(ctx.i18n.t('back_button'), 'admin_panel')]
            ]));
        } catch (e) { /* ignore */ }
        return;
    }

    let message = ctx.i18n.t('all_servers_page', { page, totalPages }) + '\n\n';
    for (const server of servers) {
        const owner = await Users.findOne({ userId: server.userId });
        const ownerUsername = owner ? (owner.username || `ID: ${owner.userId}`) : ctx.i18n.t('unknown');
        message += `🗿${server.serverName} (${server.ip}:${server.port})
`;
        message += `   - ${ctx.i18n.t('server_owner')}: ${ownerUsername}
`;
        message += `   - ${ctx.i18n.t('server_type')}: ${server.serverType}\n`;
        message += `
`;
    }

    const navigationButtons = [];
    if (page > 1) {
        navigationButtons.push(Markup.button.callback('◀️ ' + ctx.i18n.t('previous'), `admin_all_servers:${page - 1}`));
    }
    if (page < totalPages) {
        navigationButtons.push(Markup.button.callback(ctx.i18n.t('next') + ' ▶️', `admin_all_servers:${page + 1}`));
    }

    const keyboard = Markup.inlineKeyboard([
        navigationButtons,
        [Markup.button.callback(ctx.i18n.t('back_button'), 'admin_panel')]
    ]);

    try {
        await ctx.editMessageText(message, { ...keyboard });
    } catch (e) { /* ignore */ }
}



// --- بث مع خيار تثبيت الرسالة ---
const broadcastWizard = new Scenes.WizardScene(
  'admin-broadcast-wizard',
  async (ctx) => {
    // الخطوة 1: أخذ الرسالة
    try {
      ctx.wizard.state.broadcast = { pin: false };
      await ctx.reply(ctx.i18n.t('send_broadcast_message'));
      return ctx.wizard.next();
    } catch (e) { console.error(e); }
  },
  async (ctx) => {
    // استلام الرسالة المطلوب بثها
    if (ctx.message?.text === '/cancel') {
      await ctx.scene.leave();
      return ctx.reply(ctx.i18n.t('broadcast_cancelled')).catch(console.error);
    }

    ctx.wizard.state.broadcast.sourceChatId = ctx.chat.id;
    ctx.wizard.state.broadcast.sourceMessageId = ctx.message.message_id;

    const pin = ctx.wizard.state.broadcast.pin;
    const btnText = pin ? ctx.i18n.t('pin_enabled') : ctx.i18n.t('pin_disabled');

    try {
      await ctx.reply(
        ctx.i18n.t('broadcast_choose_settings'),
        Markup.inlineKeyboard([
          [Markup.button.callback(btnText, 'toggle_pin')],
          [Markup.button.callback('🚀 ' + ctx.i18n.t('send_button'), 'broadcast_send')],
          [Markup.button.callback(ctx.i18n.t('cancel_button'), 'broadcast_cancel')],
        ])
      );
    } catch (e) { console.error(e); }
  }
);

// أزرار الخيارات
broadcastWizard.action('toggle_pin', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  ctx.wizard.state.broadcast.pin = !ctx.wizard.state.broadcast.pin;
  const pin = ctx.wizard.state.broadcast.pin;
  const btnText = pin ? ctx.i18n.t('pin_enabled') : ctx.i18n.t('pin_disabled');

  try {
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([
        [Markup.button.callback(btnText, 'toggle_pin')],
        [Markup.button.callback('🚀 ' + ctx.i18n.t('send_button'), 'broadcast_send')],
        [Markup.button.callback(ctx.i18n.t('cancel_button'), 'broadcast_cancel')],
      ]).reply_markup
    );
  } catch (e) { console.error(e); }
});

broadcastWizard.action('broadcast_cancel', async (ctx) => {
  try { await ctx.answerCbQuery(ctx.i18n.t('cancelled')); } catch(e) {}
  await ctx.scene.leave();
  try { await ctx.editMessageText(ctx.i18n.t('broadcast_cancelled')); } catch(e) {}
});

broadcastWizard.action('broadcast_send', async (ctx) => {
  try { await ctx.answerCbQuery(ctx.i18n.t('sending')); } catch(e) {}

  const { sourceChatId, sourceMessageId, pin } = ctx.wizard.state.broadcast || {};
  if (!sourceChatId || !sourceMessageId) {
    await ctx.scene.leave();
    return ctx.reply(ctx.i18n.t('broadcast_no_message')).catch(console.error);
  }

  await ctx.scene.leave();
  await ctx.reply(ctx.i18n.t('broadcast_sending')).catch(console.error);

  const users = await Users.find({ isBanned: false });
  let successCount = 0, failureCount = 0, pinSuccess = 0, pinFail = 0;

  for (const user of users) {
    try {
      const sent = await ctx.telegram.copyMessage(
        user.userId,
        sourceChatId,
        sourceMessageId
      );
      successCount++;

      if (pin && sent && sent.message_id) {
        try {
          await ctx.telegram.pinChatMessage(user.userId, sent.message_id, {
            disable_notification: true
          });
          pinSuccess++;
        } catch (e) {
          pinFail++;
        }
      }
    } catch (e) {
      failureCount++;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  let result = `${ctx.i18n.t('broadcast_done')}\n\n✅ ${ctx.i18n.t('sent_to')}: ${successCount}\n❌ ${ctx.i18n.t('failed')}: ${failureCount}`;
  if (pin) {
    result += `\n\n📌 ${ctx.i18n.t('pin_results')}:\n- ${ctx.i18n.t('pinned')}: ${pinSuccess}\n- ${ctx.i18n.t('pin_failed')}: ${pinFail}`;
  }
  await ctx.reply(result).catch(console.error);
});

const userActionScene = new Scenes.BaseScene('admin-user-action-scene');

userActionScene.enter((ctx) => {
    const action = ctx.match[1];
    const actionText = { 
        'ban': ctx.i18n.t('ban_user'), 
        'unban': ctx.i18n.t('unban_user'), 
        'info': ctx.i18n.t('info_user') 
    };
    ctx.scene.state.action = action;
    ctx.reply(`${ctx.i18n.t('send_user_id_for')} ${actionText[action]}\n${ctx.i18n.t('cancel_hint')}`);
});

userActionScene.on('text', async (ctx) => {
    if (ctx.message.text === '/cancel') {
        await ctx.scene.leave();
        return ctx.reply(ctx.i18n.t('operation_cancelled'));
    }

    const targetId = parseInt(ctx.message.text.trim());
    if (isNaN(targetId)) return ctx.reply(ctx.i18n.t('invalid_id'));
    if (targetId === ADMIN_ID) return ctx.reply(ctx.i18n.t('cannot_apply_to_main_dev'));

    const user = await Users.findOne({ userId: targetId });
    if (!user) return ctx.reply(ctx.i18n.t('user_not_found'));

    const action = ctx.scene.state.action;
    switch (action) {
        case 'ban':
            await Users.updateOne({ userId: targetId }, { $set: { isBanned: true } });
            await ctx.reply(ctx.i18n.t('user_banned', { username: user.username || targetId }));
            break;

        case 'unban':
            await Users.updateOne({ userId: targetId }, { $set: { isBanned: false } });
            await ctx.reply(ctx.i18n.t('user_unbanned', { username: user.username || targetId }));
            break;

        case 'info':
            const serverCount = await Servers.countDocuments({ userId: targetId });
            const joinedDate = new Date(user.joinedAt).toLocaleDateString('en-GB');

            let info = ctx.i18n.t('user_info_header') + '\n\n' + 
                       `${ctx.i18n.t('user_id_label')}: ${user.userId}\n` + 
                       `${ctx.i18n.t('username_label')}: ${user.username || 'N/A'}\n` + 
                       `${ctx.i18n.t('is_admin_label')}: ${user.isAdmin ? ctx.i18n.t('yes') : ctx.i18n.t('no')}\n` + 
                       `${ctx.i18n.t('is_banned_label')}: ${user.isBanned ? ctx.i18n.t('yes') : ctx.i18n.t('no')}\n` + 
                       `${ctx.i18n.t('joined_label')}: ${joinedDate}\n` + 
                       `${ctx.i18n.t('servers_label')}: ${serverCount}`;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback(ctx.i18n.t('delete_all_servers'), `delete_all_servers:${targetId}`)],
                [Markup.button.callback(ctx.i18n.t('back_button'), 'admin_users')]
            ]);

            await ctx.reply(info, { parse_mode: 'Markdown', ...keyboard });
            break;
    }
    await ctx.scene.leave();
});

const adminActionScene = new Scenes.BaseScene('admin-action-scene');
adminActionScene.enter((ctx) => {
    const action = ctx.match[1];
    const actionText = { 'add': ctx.i18n.t('add_as_admin'), 'remove': ctx.i18n.t('remove_admin') };
    ctx.scene.state.action = action;
    ctx.reply(`${ctx.i18n.t('send_user_id_for')} ${actionText[action]}\n${ctx.i18n.t('cancel_hint')}`).catch(console.error);
});
adminActionScene.on('text', async (ctx) => {
    if (ctx.message.text === '/cancel') {
        await ctx.scene.leave();
        return ctx.reply(ctx.i18n.t('operation_cancelled')).catch(console.error);
    }
    const targetId = parseInt(ctx.message.text.trim());
    if (isNaN(targetId)) return ctx.reply(ctx.i18n.t('invalid_id')).catch(console.error);
    if (targetId === ADMIN_ID) return ctx.reply(ctx.i18n.t('cannot_change_main_dev')).catch(console.error);
    const user = await Users.findOne({ userId: targetId });
    if (!user) return ctx.reply(ctx.i18n.t('user_must_start_bot_first')).catch(console.error);
    const action = ctx.scene.state.action;
    if (action === 'add') {
        await Users.updateOne({ userId: targetId }, { $set: { isAdmin: true } });
        await ctx.reply(ctx.i18n.t('promoted_to_admin', { name: user.username || targetId })).catch(console.error);
        await bot.telegram.sendMessage(targetId, ctx.i18n.t('you_were_promoted')).catch(()=>{});
    } else if (action === 'remove') {
        await Users.updateOne({ userId: targetId }, { $set: { isAdmin: false } });
        await ctx.reply(ctx.i18n.t('removed_admin', { name: user.username || targetId })).catch(console.error);
    }
    await ctx.scene.leave();
});

const addVersionScene = new Scenes.WizardScene('admin-add-version-wizard',
    async (ctx) => {
        try {
            await ctx.reply(ctx.i18n.t('confirm_add_version'), Markup.inlineKeyboard([
               [Markup.button.callback(ctx.i18n.t('yes_add'), "version_type:bedrock")],
               [Markup.button.callback(ctx.i18n.t('cancel_button'), 'cancel_wizard')]
      ]));
        } catch (e) { /* ignore */ }
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_wizard') { try { await ctx.deleteMessage(); await ctx.reply(ctx.i18n.t('operation_cancelled')); } catch (e) { /* ignore */ } return ctx.scene.leave(); }
        const type = ctx.callbackQuery.data.split(':')[1];
        ctx.wizard.state.versionData = { type };
        try {
            await ctx.deleteMessage();
            await ctx.reply(ctx.i18n.t('send_version_name'));
        } catch (e) { /* ignore */ }
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.versionData.name = ctx.message.text.trim();
        try {
            await ctx.reply(ctx.i18n.t('send_protocol_number'));
        } catch (e) { /* ignore */ }
        return ctx.wizard.next();
    },
    async (ctx) => {
        const protocol = parseInt(ctx.message.text.trim());
        if (isNaN(protocol)) {
            try {
                await ctx.reply(ctx.i18n.t('protocol_must_be_number'));
            } catch (e) { /* ignore */ }
            return;
        }
        ctx.wizard.state.versionData.protocol = protocol;
        try {
            await Versions.create(ctx.wizard.state.versionData);
            await ctx.reply(ctx.i18n.t('version_added'));
        } catch (e) {
            try {
                await ctx.reply(e.code === 11000 ? ctx.i18n.t('protocol_exists') : ctx.i18n.t('unexpected_error'));
            } catch (e) { /* ignore */ }
        }
        return ctx.scene.leave();
    }
);
addVersionScene.action('cancel_wizard', async (ctx) => {
    try {
        await ctx.deleteMessage();
        await ctx.reply(ctx.i18n.t('operation_cancelled'));
    } catch (e) { /* ignore */ }
    return ctx.scene.leave();
});

const deleteVersionScene = new Scenes.BaseScene('admin-delete-version-scene');
deleteVersionScene.enter((ctx) => ctx.reply(ctx.i18n.t('send_protocol_to_delete')).catch(console.error));
deleteVersionScene.on('text', async (ctx) => {
    if (ctx.message.text === '/cancel') {
        await ctx.scene.leave();
        return ctx.reply(ctx.i18n.t('operation_cancelled')).catch(console.error);
    }
    const protocol = parseInt(ctx.message.text.trim());
    if (isNaN(protocol)) return ctx.reply(ctx.i18n.t('protocol_must_be_number')).catch(console.error);
    const result = await Versions.deleteOne({ protocol: protocol });
    await ctx.reply(result.deletedCount > 0 ? ctx.i18n.t('protocol_deleted') : ctx.i18n.t('protocol_not_found')).catch(console.error);
    await ctx.scene.leave();
});


const stage = new Scenes.Stage([
  addServerWizard,
  renameBotScene,
  broadcastWizard, // ← الجديد
  userActionScene,
  adminActionScene,
  addVersionScene,
  deleteVersionScene,
  addChannelScene,
  removeChannelScene
]);

// single bot declaration (was duplicated in original)
const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => {
    if (err.response && err.response.error_code === 400) {
        const desc = err.response.description.toLowerCase();
        if (desc.includes('message is not modified') || desc.includes('query is too old')) {
            return; // Safe to ignore
        }
        if (desc.includes('message to edit not found')) {
            console.log('Attempted to edit a message that was not found. Ignoring.');
            try {
                // Attempt to answer the callback query to prevent the user's client from hanging
                if (ctx.callbackQuery) {
                    ctx.answerCbQuery(ctx.i18n ? ctx.i18n.t('message_expired') : 'This message has expired. Please try again from the main menu.', { show_alert: true }).catch(() => {});
                }
            } catch (e) { /* ignore */ }
            return;
        }
    }

    if (err.name === 'TimeoutError') {
         console.error(`Timeout error for ${ctx.updateType}:`, err.message);
         return;
    }

    console.error(`Unhandled error for ${ctx.updateType}`, err);
});

// register middlewares: session + custom i18n middleware + stage
bot.use(session());
// custom i18n middleware (reads user's language from Users model and sets ctx.i18n.t)
function attachI18nMiddleware(UsersModel) {
    return async (ctx, next) => {
        let lang = 'en';
        try {
            if (ctx.from && UsersModel && typeof UsersModel.findOne === 'function') {
                const user = await UsersModel.findOne({ userId: ctx.from.id });
                // if user exists and has language set (not null) use it, otherwise default to en
                lang = user?.language || 'en';
            }
        } catch (e) {
            // ignore DB errors
        }
        // provide ctx.i18n.t and ctx.i18n.locale to be compatible with previous code
        ctx.i18n = {
            t: i18next.getFixedT(lang),
            locale: (l) => {
                if (l && typeof l === 'string') {
                    ctx.i18n.t = i18next.getFixedT(l);
                }
            }
        };
        return next();
    };
}
bot.use(attachI18nMiddleware(Users));
bot.use(stage.middleware());

bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return;
    if (!ctx.from) return;

    const config = await readDb('config.json');
    if (config.botOnline === false && ctx.from.id !== ADMIN_ID) {
        try {
            await ctx.reply(ctx.i18n.t('bot_under_maintenance'));
        } catch (e) { /* ignore */ }
        return;
    }

    const userId = ctx.from.id;
    let userStatus = getFromCache(userCache, userId);

    if (!userStatus) {
        const user = await Users.findOne({ userId: userId });
        if (user) {
            userStatus = { isBanned: user.isBanned, isAdmin: user.isAdmin, language: user.language || 'en' };
            setToCache(userCache, userId, userStatus, 60); 
        }
    }

    if (userStatus && userStatus.isBanned) {
        try {
            await ctx.reply(ctx.i18n.t('you_are_banned'));
        } catch (e) { /* ignore */ }
        return;
    }
    
    if (userStatus) {
        ctx.state.isAdmin = userStatus.isAdmin;
    }

    return next();
});

// 🛡️ فلتر يمنع غير الأدمن من استخدام أزرار لوحة الأدمن
bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery) return next();

    // ✅ جميع الأوامر والأزرار الخاصة بالأأدمِن
    const adminOnlyActions = [
        // لوحة الأدمن الرئيسية
        'admin_panel', 'admin_stats', 'admin_broadcast', 'admin_users',
        'admin_all_servers', 'admin_versions', 'admin_manage_admins',
        'admin_system', 'admin_settings', 'admin_channels',

        // أوامر القنوات
        'admin_add_channel', 'admin_remove_channel',

        // أوامر المستخدمين
        'user_action:', 'delete_all_servers:',

        // أوامر الإصدارات
        'version_type', 'cancel_wizard', 'admin-add-version',
        'admin-delete-version',

        // أوامر المسؤولين
        'admin-action:',

        // أي زر يبدأ بـ admin_
        'admin_'
    ];

    const data = ctx.callbackQuery.data;

    if (adminOnlyActions.some(action => data.startsWith(action))) {
        const user = await Users.findOne({ userId: ctx.from.id });
        if (!user?.isAdmin) {
            try {
                await ctx.answerCbQuery(ctx.i18n.t('admin_only_button'), { show_alert: true });
            } catch (e) { /* ignore */ }
            return; // 🚫 وقف التنفيذ
        }
    }

    return next();
});

// Helper: build the language keyboard (many languages as in provided image)
function buildLanguageKeyboard(ctx) {
    // Two-column layout to match screenshot
    const rows = [
        [Markup.button.callback('English', 'set_lang:en'), Markup.button.callback('العربية', 'set_lang:ar')],
        [Markup.button.callback('Español', 'set_lang:es'), Markup.button.callback('Português', 'set_lang:pt')],
        [Markup.button.callback('Français', 'set_lang:fr'), Markup.button.callback('Deutsch', 'set_lang:de')],
        [Markup.button.callback('Русский', 'set_lang:ru'), Markup.button.callback('Italiano', 'set_lang:it')],
        [Markup.button.callback('Nederlands', 'set_lang:nl'), Markup.button.callback('Polski', 'set_lang:pl')],
        [Markup.button.callback('Türkçe', 'set_lang:tr'), Markup.button.callback('ไทย', 'set_lang:th')],
        [Markup.button.callback('한국어', 'set_lang:ko'), Markup.button.callback('日本語', 'set_lang:ja')],
        [Markup.button.callback('বাংলা', 'set_lang:bn'), Markup.button.callback('हिन्दी', 'set_lang:hi')],
        [Markup.button.callback('中文', 'set_lang:zh'), Markup.button.callback('Svenska', 'set_lang:sv')],
        [Markup.button.callback('Bahasa Indonesia', 'set_lang:id'), Markup.button.callback('Bahasa Melayu', 'set_lang:ms')],
        [Markup.button.callback('Ελληνικά', 'set_lang:el'), Markup.button.callback('Tiếng Việt', 'set_lang:vi')],
        [Markup.button.callback(ctx ? ctx.i18n.t('back_button') : i18n.t('back_button'), 'main_menu')]
    ];
    return Markup.inlineKeyboard(rows);
}

// Language command + selector (manual)
bot.command('language', async (ctx) => {
    try {
        const keyboard = buildLanguageKeyboard(ctx);
        await ctx.reply(ctx.i18n.t('language_prompt'), keyboard);
    } catch (e) {
        console.error('Error showing language selector:', e);
    }
});

// set language handler (works both for new user and when changing language)
bot.action(/set_lang:(.+)/, async (ctx) => {
    try {
        await ctx.answerCbQuery();
    } catch (e) { /* ignore */ }
    const lang = ctx.match[1];

    // Update DB
    try {
        await Users.updateOne({ userId: ctx.from.id }, { $set: { language: lang } });
    } catch (e) { /* ignore */ }

    // Update cache and ctx locale
    setToCache(userCache, ctx.from.id, { ...(getFromCache(userCache, ctx.from.id) || {}), language: lang }, 60);
    if (ctx.i18n && typeof ctx.i18n.locale === 'function') {
        ctx.i18n.locale(lang);
    }

    // Use the fixed translator for this language when we need to show a message right away
    const t = i18n.getFixedT(lang);

    // Try to edit previous message (if callback) otherwise reply
    try {
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
            await ctx.editMessageText(t('language_changed', { lang }));
        } else {
            await ctx.reply(t('language_changed', { lang }));
        }
    } catch (e) {
        try {
            await ctx.reply(t('language_changed', { lang }));
        } catch (e) { /* ignore */ }
    }

    // Invalidate subscription cache for this user (language change might affect next steps)
    subscriptionCache.delete(ctx.from.id);

    // If user just picked language for the first time (maybe they had language null), run subscription check and show main menu
    try {
        const user = await Users.findOne({ userId: ctx.from.id });
        // Ensure ctx i18n uses updated locale
        if (ctx.i18n && typeof ctx.i18n.locale === 'function') ctx.i18n.locale(lang);

        // If user existed and previously had null language, or if they are new and we need to proceed
        if (user) {
            // If they haven't subscribed yet, checkUserSubscription will prompt
            const subscribed = await checkUserSubscription(ctx);
            if (subscribed) {
                // proceed to main menu
                await sendMainMenu(ctx);
            }
        } else {
            // fallback: send main menu
            await sendMainMenu(ctx);
        }
    } catch (e) {
        console.error('Error after setting language:', e);
    }
});

// small helper to ensure text building inside getManageServerMenu that uses translations will work when ctx not available
// (we used ctxSafeText above for static labels)

// Existing handlers updated to use translations where simple and important

bot.action('how_to_use', async (ctx) => {
    const usageText = ctx.i18n.t('how_to_use_text');

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(ctx.i18n.t('back_button'), 'main_menu')]
    ]);

    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(usageText, { ...keyboard });
        } else {
            await ctx.reply(usageText, { ...keyboard });
        }
    } catch (e) {
        console.error("Error sending usage instructions:", e.message);
    }
});

bot.start(async (ctx) => {
    try {
        subscriptionCache.delete(ctx.from.id);

        let user = await Users.findOne({ userId: ctx.from.id });
        if (!user) {
            // create user with language = null so we can ask them to choose
            user = await Users.create({
                userId: ctx.from.id,
                username: ctx.from.username || ctx.from.first_name,
                language: null
            });

            // ask for language first (don't check subscriptions yet)
            try {
                const keyboard = buildLanguageKeyboard(ctx);
                await ctx.reply(i18n.t('language_prompt'), keyboard);
                return; // wait until they pick a language
            } catch (e) {
                console.error('Error sending initial language prompt:', e);
                // fallback: set default language to en and continue
                await Users.updateOne({ userId: ctx.from.id }, { $set: { language: 'en' } });
                if (ctx.i18n && typeof ctx.i18n.locale === 'function') ctx.i18n.locale('en');
            }
        }

        // ensure i18n uses user's language
        if (ctx.i18n && typeof ctx.i18n.locale === 'function') {
            ctx.i18n.locale(user.language || 'en');
        }

        const isSubscribed = await checkUserSubscription(ctx);
        if (isSubscribed) {
            // Save user's IP and server name (if applicable) here.
            // For now, we'll just send the main menu.
            await sendMainMenu(ctx);
        }
    } catch (error) {
        console.error('Error in bot.start:', error);
        try {
            await ctx.reply(ctx.i18n ? ctx.i18n.t('unexpected_error') : i18n.t('unexpected_error'));
        } catch (e) { /* ignore */ }
    }
});

bot.action('check_subscription', async (ctx) => {
    try {
        if (!ctx.callbackQuery) return;

        await ctx.answerCbQuery(ctx.i18n.t('checking'));

        subscriptionCache.delete(ctx.from.id);

        if (ctx.i18n && typeof ctx.i18n.locale === 'function') {
            // If user exists set locale
            const user = await Users.findOne({ userId: ctx.from.id });
            ctx.i18n.locale(user?.language || 'en');
        }

        const isSubscribed = await checkUserSubscription(ctx);
        if (isSubscribed) {
            await ctx.deleteMessage().catch(()=>{});
            await ctx.reply(ctx.i18n.t('thanks_for_subscribing')).catch(()=>{});
            await sendMainMenu(ctx);
        } else {
            await ctx.answerCbQuery(ctx.i18n.t('still_not_subscribed'), { show_alert: false }).catch(()=>{});
        }
    } catch (error) {
        console.error("Error in subscription check:", error);
    }
});


bot.use(async (ctx, next) => {
    if (!ctx.from) return;

    // استثناء: المطور و الأدمن يتجاوزون الاشتراك
    if (ctx.state.isAdmin || ctx.from.id === ADMIN_ID) {
        return next();
    }

    // السماح فقط بـ /start و زر تحقق الاشتراك
    if (ctx.message?.text === '/start' || ctx.callbackQuery?.data === 'check_subscription') {
        return next();
    }

    // 🚫 مسح الكاش حتى يتحقق كل مرة
    subscriptionCache.delete(ctx.from.id);

    // تحقق من الاشتراك لكل شيء آخر (زر أو رسالة)
    const isSubscribed = await checkUserSubscription(ctx, false);

    if (!isSubscribed) {
        // إذا مو مشترك يوقف فوراً
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery(ctx.i18n.t('subscribe_first'), { show_alert: true }).catch(() => {});
        }
        return; 
    }

    return next();
});


bot.command('cancel', async (ctx) => {
    await ctx.scene.leave();
    try {
        await ctx.reply(ctx.i18n.t('operation_cancelled'));
    } catch (e) { /* ignore */ }
    await sendMainMenu(ctx);
});


async function sendMainMenu(ctx) {
    const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    const text = ctx.i18n.t('welcome_message', { name: fullName });

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(ctx.i18n.t('my_servers'), 'my_servers'), Markup.button.callback(ctx.i18n.t('add_server'), 'add_server_wizard')],
        [Markup.button.callback(ctx.i18n.t('how_to_use_button') || ctx.i18n.t('how_to_use_text'), 'how_to_use')],
        ...(ctx.state.isAdmin || ctx.from.id === ADMIN_ID) ? [[Markup.button.callback(ctx.i18n.t('admin_panel'), 'admin_panel')]] : [],
    ]);

    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, { ...keyboard });
        } else {
            await ctx.reply(text, { ...keyboard });
        }
    } catch (e) {
        if (e.response && e.response.description.includes('message to edit not found')) {
            try {
                await ctx.reply(text, { ...keyboard });
            } catch (replyError) {
                console.error("Error sending main menu as a reply after edit failed:", replyError.message);
            }
        } else if (!(e.response && e.response.description.includes('message is not modified'))) {
            console.error("Error sending main menu:", e.message);
        }
    }
}

bot.action('main_menu', sendMainMenu);
bot.action('add_server_wizard', async (ctx) => {
    try {
        const count = await Servers.countDocuments({ userId: ctx.from.id });

        if (count >= 3) {
            return ctx.answerCbQuery(
                ctx.i18n.t('max_servers_reached_alert'),
                { show_alert: true }
            ).catch(()=>{});
        }

        return ctx.scene.enter('add-server-wizard');
    } catch (error) {
        console.error('Error in add_server_wizard:', error);
    }
});

async function showMyServers(ctx, message) {
    const allServers = await Servers.find({ userId: ctx.from.id });
    const servers = allServers.filter(s => s.serverType === 'bedrock');

    if (servers.length === 0) {
        try {
            await ctx.editMessageText(ctx.i18n.t('no_bedrock_servers'), Markup.inlineKeyboard([
                [Markup.button.callback(ctx.i18n.t('add_server_now'), 'add_server_wizard')],
                [Markup.button.callback(ctx.i18n.t('back_button'), 'main_menu')]
            ]));
        } catch (e) { /* Ignore if message not modified */ }
        return;
    }
    const text = message || ctx.i18n.t('choose_server');
    const buttons = servers.map(s => {
        const statusIcon = s.status === 'نشط' ? '🟢' : (s.status === 'متوقف' ? '🔴' : '🟡');
        return [Markup.button.callback(`${statusIcon} ${s.serverName} (${s.ip})`, `manage_server:${s._id}`)];
    });
    buttons.push([Markup.button.callback(ctx.i18n.t('refresh'), 'my_servers')]);
    buttons.push([Markup.button.callback(ctx.i18n.t('back_button'), 'main_menu')]);
    try {
        await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
    } catch (e) { /* Ignore if message not modified */ }
}
bot.action('my_servers', async (ctx) => { await showMyServers(ctx); });

bot.action(/manage_server:(.+)/, async (ctx) => {
    const serverId = ctx.match[1];
    await manageServerAction(ctx, serverId);
});

bot.action(/start_bot:(.+)/, async (ctx) => { try { await ctx.answerCbQuery(ctx.i18n.t('sending_start_command')); } catch(e) {/*ignore*/} await startBot(ctx, ctx.match[1]); });
bot.action(/stop_bot:(.+)/, async (ctx) => { await stopBot(ctx, ctx.match[1]); });
bot.action(/toggle_autorestart:(.+)/, async (ctx) => { try { await ctx.answerCbQuery(); } catch(e) {/*ignore*/} const s = await Servers.findById(ctx.match[1]); await Servers.updateOne({_id: s._id}, { $set: { autoRestart: !s.autoRestart } }); ctx.update.callback_query.data = `manage_server:${ctx.match[1]}`; await bot.handleUpdate(ctx.update); });
bot.action(/toggle_notify:(.+)/, async (ctx) => { try { await ctx.answerCbQuery(); } catch(e) {/*ignore*/} const s = await Servers.findById(ctx.match[1]); await Servers.updateOne({_id: s._id}, { $set: { notifyOnError: !s.notifyOnError } }); ctx.update.callback_query.data = `manage_server:${ctx.match[1]}`; await bot.handleUpdate(ctx.update); });
bot.action(/info_server:(.+)/, async (ctx) => {
    try {
        await ctx.answerCbQuery(ctx.i18n.t('fetching_info'));
    } catch (e) { /* ignore */ }
    const server = await Servers.findById(ctx.match[1]);
    if (!server) return;

    try {
        const result = await statusBedrock(server.ip, server.port, { timeout: 5000 });
        let info = `${ctx.i18n.t('server_info_title', { name: server.serverName })}\n\n` + 
                   `${ctx.i18n.t('version_label')}: ${result.version.name_clean || result.version.name}\n` + 
                   `${ctx.i18n.t('players_label')}: ${result.players.online} / ${result.players.max}\n`;
        if(result.motd) info += `${ctx.i18n.t('description_label')}:\n${result.motd.clean}`;
        await ctx.editMessageText(info, { reply_markup: { inline_keyboard: [[Markup.button.callback(ctx.i18n.t('back_button'), `manage_server:${ctx.match[1]}`)]] } });
    } catch (e) {
        console.error(`❌ Failed to fetch server info (${server.serverName}):`, e.message);
        try {
            await ctx.answerCbQuery(ctx.i18n.t('cannot_reach_server'), { show_alert: true });
        } catch (e) { /* ignore */ }
    }
});
bot.action(/delete_confirm:(.+)/, async (ctx) => { try { await ctx.editMessageText(ctx.i18n.t('confirm_delete_server'), Markup.inlineKeyboard([[Markup.button.callback(ctx.i18n.t('yes_delete'), `delete_do:${ctx.match[1]}`), Markup.button.callback(ctx.i18n.t('no_cancel'), `manage_server:${ctx.match[1]}`)]])); } catch(e) {/*ignore*/} });
bot.action(/delete_do:(.+)/, async (ctx) => { 
    try { await ctx.answerCbQuery(ctx.i18n.t('deleting')); } catch(e) {/*ignore*/} 
    const sId = ctx.match[1]; 
    if (activeClients.has(sId)) { 
        await stopBot(ctx, sId).catch(()=>{}); 
    } 
    await Servers.deleteOne({ _id: sId, userId: ctx.from.id }); 

    // 🆕 إعادة الترقيم بعد الحذف
    await reorderServers(ctx.from.id);

    await showMyServers(ctx, ctx.i18n.t('server_deleted')); 
});


bot.action(/uptime_server:(.+)/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e) {}

    const serverId = ctx.match[1];
    const botInfo = activeClients.get(serverId);

    if (!botInfo || !botInfo.startTime) {
        return ctx.editMessageText(
            ctx.i18n.t('bot_not_active'),
            { reply_markup: { inline_keyboard: [[Markup.button.callback(ctx.i18n.t('back_button'), `manage_server:${serverId}`)]] } }
        );
    }

    // حساب المدة
    const diff = Date.now() - botInfo.startTime;
    const seconds = Math.floor(diff / 1000) % 60;
    const minutes = Math.floor(diff / 60000) % 60;
    const hours = Math.floor(diff / 3600000);

    const uptimeText = ctx.i18n.t('uptime_text', { hours, minutes, seconds });

    await ctx.editMessageText(
        uptimeText,
        { reply_markup: { inline_keyboard: [[Markup.button.callback(ctx.i18n.t('refresh'), `uptime_server:${serverId}`), Markup.button.callback(ctx.i18n.t('back_button'), `manage_server:${serverId}`)]] } }
    );
});

bot.action('admin_panel', async (ctx) => {
    const user = await Users.findOne({ userId: ctx.from.id });
    if (user?.isAdmin !== true) {
        try {
            return ctx.answerCbQuery(ctx.i18n.t('not_admin'), { show_alert: true });
        } catch (e) { /* ignore */ }
        return;
    }
    const text = ctx.i18n.t('admin_panel_welcome');
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(ctx.i18n.t('stats'), 'admin_stats'), Markup.button.callback(ctx.i18n.t('broadcast_all'), 'admin_broadcast')],
        [Markup.button.callback(ctx.i18n.t('manage_users'), 'admin_users'), Markup.button.callback(ctx.i18n.t('view_all_servers'), 'admin_all_servers')],
        [Markup.button.callback(ctx.i18n.t('manage_versions'), 'admin_versions'), Markup.button.callback(ctx.i18n.t('manage_admins'), 'admin_manage_admins')],
        [Markup.button.callback(ctx.i18n.t('system_status'), 'admin_system')],
        [Markup.button.callback(ctx.i18n.t('bot_settings'), 'admin_settings')],
        [Markup.button.callback(ctx.i18n.t('back_button'), 'main_menu')]
    ]);
    try {
        await ctx.editMessageText(text, keyboard);
    } catch (e) { /* ignore */ }
});
bot.action('admin_channels', async (ctx) => {
    const config = await readDb('config.json');
    const channels = config.requiredChannels || [];

    let message = ctx.i18n.t('manage_required_channels') + '\n\n';
    if (channels.length > 0) {
        message += ctx.i18n.t('current_channels') + '\n';
        channels.forEach(ch => { message += `- ${ch}\n`; });
    } else {
        message += ctx.i18n.t('no_required_channels');
    }

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(ctx.i18n.t('add_channel'), 'admin_add_channel'), Markup.button.callback(ctx.i18n.t('remove_channel'), 'admin_remove_channel')],
        [Markup.button.callback(ctx.i18n.t('back_button'), 'admin_settings')]
    ]);

    try {
        await ctx.editMessageText(message, { ...keyboard });
    } catch (e) { /* ignore */ }
});

bot.action('admin_add_channel', (ctx) => ctx.scene.enter('admin-add-channel-scene'));
bot.action('admin_remove_channel', (ctx) => ctx.scene.enter('admin-remove-channel-scene'));
bot.action('admin_stats', async (ctx) => {
    const totalUsers = await Users.countDocuments();
    const bannedUsers = await Users.countDocuments({ isBanned: true });
    const adminUsers = await Users.countDocuments({ isAdmin: true });
    const totalServers = await Servers.countDocuments();
    const activeBots = activeClients.size;
    const text = ctx.i18n.t('stats_text', { totalUsers, adminUsers, bannedUsers, totalServers, activeBots });
    try {
        await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [[Markup.button.callback(ctx.i18n.t('back_button'), 'admin_panel')]] } });
    } catch (e) { /* ignore */ }
});


bot.action('admin_system', async (ctx) => {
    try {
        const stats = await pidusage(process.pid);

        const totalMem = os.totalmem() / 1024 / 1024; // MB
        const freeMem = os.freemem() / 1024 / 1024;   // MB
        const usedMem = totalMem - freeMem;

        const text = ctx.i18n.t('system_status_text', {
            cpu: stats.cpu.toFixed(2),
            used: (usedMem).toFixed(2),
            total: (totalMem).toFixed(2),
            botRam: (stats.memory / 1024 / 1024).toFixed(2),
            uptimeMinutes: (process.uptime() / 60).toFixed(2)
        });

        await ctx.editMessageText(text, {
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback(ctx.i18n.t('refresh'), 'admin_system')],
                    [Markup.button.callback(ctx.i18n.t('back_button'), 'admin_panel')]
                ]
            }
        });
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery(ctx.i18n.t('error_fetching_status'), { show_alert: true });
    }
});

bot.action(/delete_all_servers:(\d+)/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    try {
        const servers = await Servers.find({ userId });
        if (servers.length === 0) {
            return ctx.answerCbQuery(ctx.i18n.t('user_no_servers'), { show_alert: true });
        }

        for (const server of servers) {
            if (activeClients.has(server._id)) {
                await stopBot(ctx, server._id).catch(() => {});
            }
            await Servers.deleteOne({ _id: server._id, userId });
        }

        await ctx.answerCbQuery(ctx.i18n.t('all_servers_deleted'), { show_alert: true });
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery(ctx.i18n.t('error_deleting_servers'), { show_alert: true });
    }
});

bot.action('admin_broadcast', (ctx) => ctx.scene.enter('admin-broadcast-wizard'));
bot.action('admin_users', async (ctx) => { try { await ctx.editMessageText(ctx.i18n.t('manage_users_title'), Markup.inlineKeyboard([[Markup.button.callback(ctx.i18n.t('ban'), 'user_action:ban'), Markup.button.callback(ctx.i18n.t('unban'), 'user_action:unban')], [Markup.button.callback(ctx.i18n.t('view_info'), 'user_action:info')], [Markup.button.callback(ctx.i18n.t('back_button'), 'admin_panel')]])); } catch(e) {/*ignore*/} });
bot.action(/user_action:(.+)/, (ctx) => ctx.scene.enter('admin-user-action-scene', { action: ctx.match[1] }));
bot.action(/rename_bot:(.+)/, (ctx) => ctx.scene.enter('rename-bot-scene', { serverId: ctx.match[1] }));

bot.action('admin_manage_admins', async (ctx) => {
    const allUsers = await Users.find();
    const admins = allUsers.filter(u => u.isAdmin === true && u.userId !== undefined);
    
    let text = ctx.i18n.t('current_admins') + '\n\n';
    
    if (admins.length === 0) {
        text += ctx.i18n.t('no_admins');
    } else {
        const sortedAdmins = admins
            .sort((a, b) => a.userId === ADMIN_ID ? -1 : b.userId === ADMIN_ID ? 1 : 0)
            .slice(0, 10);
        
        sortedAdmins.forEach(admin => { 
            const label = admin.userId === ADMIN_ID ? ctx.i18n.t('main_dev') : `${ctx.i18n.t('admin_label')} - ${admin.username || ctx.i18n.t('unknown')}`;
            text += `• ${admin.userId} (${label})\n`; 
        });
        
        if (admins.length > 10) {
            text += `\n... ${ctx.i18n.t('and_more', { n: admins.length - 10 })}`;
        }
        
        text += `\n\n${ctx.i18n.t('total_admins', { n: admins.length })}`;
    }
    
    try {
        await ctx.editMessageText(text, { 
            reply_markup: { 
                inline_keyboard: [
                    [Markup.button.callback(ctx.i18n.t('add_admin'), 'admin_action:add'), Markup.button.callback(ctx.i18n.t('remove_admin'), 'admin_action:remove')], 
                    [Markup.button.callback(ctx.i18n.t('back_button'), 'admin_panel')]
                ] 
            } 
        });
    } catch (e) { /* ignore */ }
});
bot.action(/admin_action:(add|remove)/, (ctx) => ctx.scene.enter('admin-action-scene', { action: ctx.match[1] }));

bot.action('admin_versions', async (ctx) => { 
    try { 
        await ctx.editMessageText(
            ctx.i18n.t('manage_versions_title'),
            Markup.inlineKeyboard([
                [Markup.button.callback(ctx.i18n.t('list_all'), 'admin_list_versions')],
                [Markup.button.callback(ctx.i18n.t('add_version'), 'admin_add_version'), Markup.button.callback(ctx.i18n.t('delete_version'), 'admin_delete_version')],
                [Markup.button.callback(ctx.i18n.t('back_button'), 'admin_panel')]
            ])
        ); 
    } catch(e) { /* ignore */ } 
});

bot.action('admin_list_versions', async (ctx) => {
    try {
        await ctx.answerCbQuery(ctx.i18n.t('fetching_list'));
    } catch (e) { /* ignore */ }

    const versions = await Versions.find({ type: 'bedrock' }); // فقط Bedrock
    versions.sort((a, b) => b.protocol - a.protocol);

    let bedrockText = ctx.i18n.t('bedrock_label') + ':\n';
    versions.forEach(v => {
        bedrockText += `${v.name} -> ${v.protocol}\n`;
    });

    try {
        await ctx.editMessageText(bedrockText, { 
            reply_markup: { 
                inline_keyboard: [[Markup.button.callback(ctx.i18n.t('back_button'), 'admin_versions')]] 
            } 
        });
    } catch (e) { /* ignore */ }
});

bot.action('admin_add_version', (ctx) => ctx.scene.enter('admin-add-version-wizard'));
bot.action('admin_delete_version', (ctx) => ctx.scene.enter('admin-delete-version-scene'));

bot.action('admin_settings', async (ctx) => {
    const config = await readDb('config.json');
    const botOnline = config.botOnline ?? true;
    try {
        await ctx.editMessageText(ctx.i18n.t('bot_settings_title'), Markup.inlineKeyboard([[Markup.button.callback(`${ctx.i18n.t('bot_status')}: ${botOnline ? ctx.i18n.t('on') : ctx.i18n.t('off')}`, 'admin_toggle_bot_status')],[Markup.button.callback(ctx.i18n.t('manage_required_channels'), 'admin_channels')], [Markup.button.callback(ctx.i18n.t('back_button'), 'admin_panel')]]));
    } catch (e) { /* ignore */ }
});
bot.action('admin_toggle_bot_status', async (ctx) => {
    let config = await readDb('config.json');
    const currentStatus = config.botOnline ?? true;
    config.botOnline = !currentStatus;
    await writeDb('config.json', config);
    try {
        await ctx.answerCbQuery(ctx.i18n.t('bot_status_changed', { status: !currentStatus ? ctx.i18n.t('on') : ctx.i18n.t('off') }));
    } catch (e) { /* ignore */ }
    ctx.update.callback_query.data = 'admin_settings';
    await bot.handleUpdate(ctx.update);
});
bot.action('admin_all_servers', (ctx) => showAllServers(ctx, 1));

bot.action(/admin_all_servers:(\d+)/, (ctx) => {
    const page = parseInt(ctx.match[1]);
    showAllServers(ctx, page);
});
const startBotApp = async () => {
    try {
        await initI18next(); // <-- initialize i18next before launching the bot
        await setupInitialConfig();
        await bot.launch();
        console.log('Telegram bot is running.');
    } catch (err) {
        console.error("Failed to initialize and launch the bot:", err);
        process.exit(1);
    }
};

startBotApp();

async function checkServersStatus() {
    if (activeClients.size > 0) {
        console.log(`🚀 بدء فحص ${activeClients.size} سيرفر شغّال...`);
    }

    for (const [serverId, clientInfo] of activeClients.entries()) {
        try {
            // serverId is the map key (we store by server._id)
            let isOnline = false;

            // تحقق من حالة الكلاينت فعلياً
            if (clientInfo && clientInfo.client && (clientInfo.client.connected || clientInfo.client.isAlive)) {
                isOnline = true;
            } else {
                // تنظيف إذا الكلاينت ميت
                activeClients.delete(serverId);
            }

            // احصل على السيرفر لمعرفة userId وتحديث الحالة
            const server = await Servers.findById(serverId);
            if (!server) continue;

            await Servers.updateOne(
                { _id: serverId, userId: server.userId },
                { $set: { status: isOnline ? 'نشط' : 'متوقف' } }
            );
        } catch (e) {
            console.error(`⚠️ خطأ بفحص السيرفر ${serverId}:`, e.message);
            try {
                const server = await Servers.findById(serverId);
                if (server) {
                    await Servers.updateOne(
                        { _id: serverId, userId: server.userId },
                        { $set: { status: 'غير معروف' } }
                    );
                }
            } catch (inner) { /* ignore */ }
        }
    }

    if (activeClients.size > 0) {
        console.log("✅ فحص السيرفرات المشغلة اكتمل.");
    }
}

// ⏰ خليها تشتغل كل 5 ساعات (5 * 60 * 60 * 1000 = 18000000ms)
const CHECK_INTERVAL = 5 * 60 * 60 * 1000; // 5 hours
setInterval(checkServersStatus, CHECK_INTERVAL);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


bot.telegram.setMyCommands([
    { command: 'start', description: 'بدء البوت 🤖' },
    { command: 'language', description: 'Change language / تغيير اللغة' }
]);
