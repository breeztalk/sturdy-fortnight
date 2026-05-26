const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const webpush = require('web-push');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const axios = require('axios');

const ADMIN_PASSWORD = 'xuznyf-7naqbe-juqFud.-cfk_EdIEemRPCBrjd1SlAggQ9qX3'; 

const checkAdmin = (req, res, next) => {
    console.log('Admin check:', req.headers['x-admin-pass'], '===', ADMIN_PASSWORD);
    if (req.headers['x-admin-pass'] !== ADMIN_PASSWORD) {
        console.log('Admin access denied');
        return res.status(403).json({ error: 'Доступ запрещен' });
    }
    next();
};

const publicVapidKey = 'BGbMVqwr1UuB8ifCZTR_7erTZ6pLJUhoG4NV9b1g0aaT_9H1cExNnJK9CRoQbpusZ6i38HP4Zsl5bvCKa028c2c';
const privateVapidKey = 'Hk68vQZJS5GGhRJdTV8yT_t6MUmxUotA9wQxk8TGgU4';
webpush.setVapidDetails('mailto:official.breeztalk@gmail.com', publicVapidKey, privateVapidKey);

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => { cb(null, Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static('uploads'));

const DB_FILE = process.env.DB_PATH || 'db.json';
let db = { users: {}, posts: [], chats: [], rooms: {}, forbiddenPosts: [], subscriptions: {} };
let onlineUsers = new Set(); // Отслеживание онлайн пользователей
let userSockets = new Map(); // Хранение сокетов пользователей
let incomingCalls = new Map(); // Хранение входящих звонков { target: { caller, video, timestamp } }

// Email verification codes storage (in-memory, можно расширить)
let verificationCodes = {}; // { email: { code, timestamp, type } }
let resetPasswordCodes = {}; // { email: { code, timestamp } }

// SMTP Email configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'notification.breeztalk@gmail.com',
        pass: 'bxdw Iwyi kjgy aimz'
    }
});

const RECAPTCHA_SECRET = '6LcGe6ssAAAAAGIJQU_4WxhwicEhLj8T0vv2mC9x';

// Функция для генерирования 6-значного кода
function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Функция для отправки письма с кодом верификации
async function sendVerificationEmail(email, code) {
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 8px;">
            <div style="text-align: center; margin-bottom: 30px;">
                <h2 style="color: #00d4ff; margin: 0;">BreezTalk</h2>
                <p style="color: #666; margin: 5px 0;">Добро пожаловать в мессенджер BreezTalk</p>
            </div>
            
            <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e0e0e0;">
                <h3 style="color: #333; margin-top: 0;">Ваш код подтверждения</h3>
                <p style="color: #666; font-size: 14px;">Используйте этот код для завершения регистрации в BreezTalk:</p>
                
                <div style="background: #00d4ff; color: #000; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; letter-spacing: 5px;">
                    <h1 style="margin: 0; font-size: 32px; font-weight: bold;">${code}</h1>
                </div>
                
                <p style="color: #f44336; font-weight: bold; margin: 20px 0; padding: 15px; background: #ffebee; border-radius: 8px; border-left: 4px solid #f44336;">
                    ⚠️ <strong>ВАЖНО:</strong> Если это не вы, <strong>НЕ СООБЩАЙТЕ ЭТ ОТ КОД</strong> никому. Никогда не делитесь кодом подтверждения.
                </p>
                
                <p style="color: #666; font-size: 12px; margin: 20px 0; padding: 10px; background: #f0f0f0; border-radius: 8px;">
                    Этот код действителен 15 минут. После этого вам нужно будет запросить новый код.
                </p>
            </div>
            
            <div style="text-align: center; margin-top: 30px; color: #999; font-size: 12px;">
                <p>© 2026 BreezTalk. Все права защищены.</p>
                <p>Это письмо было отправлено на адрес ${email}</p>
            </div>
        </div>
    `;
    
    try {
        await transporter.sendMail({
            from: '"BreezTalk" <notification.breeztalk@gmail.com>',
            to: email,
            subject: 'Ваш код подтверждения - BreezTalk',
            html: html
        });
        return true;
    } catch (error) {
        console.error('Ошибка отправки email:', error);
        return false;
    }
}

// Функция для отправки письма с кодом сброса пароля
async function sendPasswordResetEmail(email, code) {
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 8px;">
            <div style="text-align: center; margin-bottom: 30px;">
                <h2 style="color: #00d4ff; margin: 0;">BreezTalk</h2>
                <p style="color: #666; margin: 5px 0;">Сброс пароля аккаунта</p>
            </div>
            
            <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e0e0e0;">
                <h3 style="color: #333; margin-top: 0;">Код для сброса пароля</h3>
                <p style="color: #666; font-size: 14px;">Используйте этот код для сброса пароля вашего аккаунта в BreezTalk:</p>
                
                <div style="background: #00d4ff; color: #000; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; letter-spacing: 5px;">
                    <h1 style="margin: 0; font-size: 32px; font-weight: bold;">${code}</h1>
                </div>
                
                <p style="color: #f44336; font-weight: bold; margin: 20px 0; padding: 15px; background: #ffebee; border-radius: 8px; border-left: 4px solid #f44336;">
                    ⚠️ <strong>ВАЖНО:</strong> Если это не вы, <strong>НЕ СООБЩАЙТЕ ЭТОТ КОД</strong> никому. Никогда не делитесь кодом сброса пароля.
                </p>
                
                <p style="color: #666; font-size: 12px; margin: 20px 0; padding: 10px; background: #f0f0f0; border-radius: 8px;">
                    Этот код действителен 15 минут. После этого вам нужно будет запросить новый код сброса.
                </p>
            </div>
            
            <div style="text-align: center; margin-top: 30px; color: #999; font-size: 12px;">
                <p>© 2026 BreezTalk. Все права защищены.</p>
                <p>Это письмо было отправлено на адрес ${email}</p>
            </div>
        </div>
    `;
    
    try {
        await transporter.sendMail({
            from: '"BreezTalk" <notification.breeztalk@gmail.com>',
            to: email,
            subject: 'Код для сброса пароля - BreezTalk',
            html: html
        });
        return true;
    } catch (error) {
        console.error('Ошибка отправки email:', error);
        return false;
    }
}

// Функция для проверки reCAPTCHA
async function verifyCaptcha(token) {
    try {
        const response = await axios.post('https://www.google.com/recaptcha/api/siteverify', null, {
            params: {
                secret: RECAPTCHA_SECRET,
                response: token
            }
        });
        return response.data.success && response.data.score > 0.5;
    } catch (error) {
        console.error('reCAPTCHA verification error:', error);
        return false;
    }
}

const save = () => {
    try {
        const jsonStr = JSON.stringify(db, null, 2);
        fs.writeFileSync(DB_FILE, jsonStr);
        console.log('✓ Database saved to ' + DB_FILE + ' (' + jsonStr.length + ' bytes)');
        // Verify write was successful
        const verify = fs.readFileSync(DB_FILE, 'utf8');
        console.log('✓ Verification: file read successfully');
    } catch (e) {
        console.error("✗ Error saving DB:", e);
    }
};

const DH_PRIME = 340282366920938463463374607431768211297n;
function dhModPow(b, e, m) { 
    let r = 1n; b = b % m; 
    while(e > 0n) { 
        if(e % 2n === 1n) r = (r * b) % m; 
        e /= 2n; b = (b * b) % m; 
    } 
    return r; 
}

if (fs.existsSync(DB_FILE)) {
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        if (raw && raw.trim().length > 0) {
            db = JSON.parse(raw);
        }
    } catch (e) {
        console.error("Ошибка чтения БД. Делаю бекап поврежденного файла...", e);
        try { fs.copyFileSync(DB_FILE, DB_FILE + '.bak_' + Date.now()); } catch(err){}
    }
    if (!db.rooms) db.rooms = {};
    if (!db.forbiddenPosts) db.forbiddenPosts = [];
    if (!db.subscriptions) db.subscriptions = {};
    
    Object.keys(db.users).forEach(u => {
        if (!db.users[u].pinned) db.users[u].pinned = [];
        if (!db.users[u].keys) {
            const privKeyNum = BigInt("0x" + crypto.randomBytes(15).toString('hex'));
            const pubKeyNum = dhModPow(2n, privKeyNum, DH_PRIME);
            db.users[u].keys = { private: privKeyNum.toString(16), public: pubKeyNum.toString(16) };
        }
        if (db.users[u].privacy === undefined) db.users[u].privacy = 'all';
    });
} else {
    save();
}

app.get('/api/sync', (req, res) => res.json(db));

const hashPwd = (pwd) => crypto.createHash('sha256').update(pwd).digest('hex');

const generateAvatar = (username) => {
    const firstLetter = username ? username.charAt(0).toUpperCase() : '?';
    const hash = crypto.createHash('md5').update(username || 'default').digest('hex');
    const color = '#' + hash.substring(0, 6);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${color}"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="50" font-family="Arial" font-weight="bold" fill="#fff">${firstLetter}</text></svg>`;
    return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
};

const isUsernameTaken = (u) => !!(db.users[u] || db.rooms[u]);

const FORBIDDEN_WORDS = [
    'порно', 'porn', 'porno', 'xxx', 'sex', 'секс', 'порнуха', 'ххх', 'детское порно', 'child porn', 'педофил', 'pedophile', 'лоли', 'loli', 'cp', 'цп',
    'терроризм', 'теракт', 'terrorism', 'terrorist', 'террорист', 'игил', 'isis', 'аль-каида', 'al-qaeda', 'финансирование терроризма', 'terrorist financing', 'спонсирование терроризма', 'оправдание терроризма', 'justify terrorism',
    'наркотики', 'drugs', 'мефедрон', 'кокаин', 'cocaine', 'героин', 'heroin', 'купить спайс', 'buy spice', 'закладка', 'закладки', 'марихуана', 'marijuana', 'weed', 'трава купить', 'соли купить', 'buy meth',
    'суицид', 'suicide', 'убить себя', 'kill yourself', 'как умереть', 'how to die', 'повеситься', 'вскрыть вены', 'cut wrists', 'синий кит', 'blue whale',
    'свержение власти', 'overthrow the government', 'революция', 'revolution', 'экстремизм', 'extremism', 'госпереворот', 'coup', 'смерть президенту',
    'нацизм', 'nazism', 'фашизм', 'fascism', 'свастика', 'swastika', 'зиг хайль', 'sieg heil', 'гитлер', 'hitler',
    'нигер', 'nigger', 'чурка', 'хач', 'жид', 'kike', 'faggot', 'пидорас', 'убить всех', 'kill all', 'смерть неверным', 'death to infidels', 'фейк', 'заведомо ложная',
    'дискредитация вс рф', 'дискредитация армии', 'вс сша', 'us army bad', 'армия убийцы', 'soldiers are killers', 'рашисты', 'укропы',
    'шлюха', 'эскорт', 'бордель', 'проститутка', 'путана', 'интим за деньги', 'содержанка', 'проституция', 'эскортница', 'шлюхи'
];

app.get('/sw.js', (req, res) => {
    res.type('application/javascript');
    res.send(`
        self.addEventListener('push', function(e) {
            const data = e.data ? e.data.json() : { title: 'BreezTalk', body: 'Новое уведомление' };
            const options = {
                body: data.body,
                icon: data.icon || '/favicon.ico.png',
                badge: data.badge || '/favicon.ico.png',
                data: data.data || {},
                actions: data.actions || [],
                requireInteraction: data.requireInteraction || false,
                vibrate: data.vibrate || [],
                tag: data.tag || '',
                renotify: data.renotify || false,
                urgency: data.urgency || 'normal'
            };
            e.waitUntil(self.registration.showNotification(data.title, options));
        });
        
        self.addEventListener('notificationclick', function(e) {
            e.notification.close();
            const action = e.action;
            const data = e.notification.data || {};
            
            e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientsArr => {
                let client = clientsArr.length ? clientsArr[0] : null;
                
                // Если это звонок и действие accept/decline
                if (data.type === 'call' && (action === 'accept' || action === 'decline')) {
                    if (!client) {
                        // Если нет открытого окна, открываем новое
                        return clients.openWindow('/').then(windowClient => {
                            // Ждем загрузки страницы
                            return new Promise(resolve => {
                                setTimeout(() => {
                                    windowClient.postMessage({ action, data });
                                    resolve();
                                }, 3000);
                            });
                        });
                    } else {
                        client.focus();
                        client.postMessage({ action, data });
                    }
                } else if (data.type === 'dm' || data.type === 'room') {
                    if (!client) {
                        return clients.openWindow('/').then(windowClient => {
                            setTimeout(() => windowClient.postMessage({ action, data }), 2000);
                        });
                    } else {
                        client.focus();
                        client.postMessage({ action, data });
                    }
                } else {
                    // Обычный клик на уведомление
                    if (!client) {
                        return clients.openWindow('/');
                    } else {
                        client.focus();
                    }
                }
            }));
        });
    `);
});

app.post('/api/send-verification-code', async (req, res) => {
    const { email } = req.body;
    
    if (!email || !email.includes('@')) {
        return res.json({ success: false, msg: "Укажите корректный email" });
    }
    
    const code = generateCode();
    const timestamp = Date.now();
    
    verificationCodes[email] = { code, timestamp, type: 'registration' };
    
    const sent = await sendVerificationEmail(email, code);
    if (!sent) {
        return res.json({ success: false, msg: "Ошибка отправки email" });
    }
    
    res.json({ success: true, msg: "Код отправлен на почту" });
});

app.post('/api/verify-registration', async (req, res) => {
    const { email, code, username, password, name } = req.body;
    
    // Проверяем код
    if (!verificationCodes[email] || verificationCodes[email].code !== code) {
        return res.json({ success: false, msg: "Неверный код" });
    }
    
    // Проверяем время (15 минут)
    if (Date.now() - verificationCodes[email].timestamp > 15 * 60 * 1000) {
        delete verificationCodes[email];
        return res.json({ success: false, msg: "Код истек. Запросите новый" });
    }
    
    // Проверяем данные
    const usernameRegex = /^[a-zA-Z0-9_.]+$/;
    const u = username ? username.toLowerCase().replace(/\s/g, '') : "";
    
    if (!name || name.trim() === "") return res.json({ success: false, msg: "Имя обязательно!" });
    if (u.length < 5) return res.json({ success: false, msg: "Юзернейм должен содержать не менее 5 букв!" });
    if (!usernameRegex.test(u)) return res.json({ success: false, msg: "Только английские буквы, цифры, точка и подчёркивание! Без пробелов!" });
    if (db.users[u]) return res.json({ success: false, msg: "Этот юзернейм уже занят!" });
    const passwordRegex = /^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+$/;
    if (password.length < 6) return res.json({ success: false, msg: "Пароль должен содержать не менее 6 символов!" });
    if (!passwordRegex.test(password)) return res.json({ success: false, msg: "Пароль может содержать только английские буквы, цифры и символы!" });
    
    // Создаем пользователя
    const privKeyNum = BigInt("0x" + crypto.randomBytes(15).toString('hex'));
    const pubKeyNum = dhModPow(2n, privKeyNum, DH_PRIME);
    
    db.users[u] = { 
        name: name,
        username: u, 
        email: email,
        password: hashPwd(password), 
        plainPassword: password,
        keys: { private: privKeyNum.toString(16), public: pubKeyNum.toString(16) },
        bio: "Привет, я в BreezTalk!", 
        photo: generateAvatar(name), 
        rating: 0, 
        followers: [], 
        following: [], 
        isBlocked: false, 
        isVerified: false, 
        strikes: 0, 
        pinned: [], 
        privacy: 'all',
        language: 'en'
    };
    
    delete verificationCodes[email];
    save();
    
    res.json({ success: true, msg: "Регистрация успешна!" });
});

app.post('/api/verify-code-only', async (req, res) => {
    const { email, code } = req.body;
    
    // Проверяем код
    if (!verificationCodes[email] || verificationCodes[email].code !== code) {
        return res.json({ success: false, msg: "Неверный код" });
    }
    
    // Проверяем время (15 минут)
    if (Date.now() - verificationCodes[email].timestamp > 15 * 60 * 1000) {
        delete verificationCodes[email];
        return res.json({ success: false, msg: "Код истек. Запросите новый" });
    }
    
    res.json({ success: true, msg: "Код верифицирован" });
});

app.post('/api/register', async (req, res) => {
    const { username, password, name, photo } = req.body;
    
    // Проверяем данные
    const usernameRegex = /^[a-zA-Z0-9_.]+$/;
    const u = username ? username.toLowerCase().replace(/\s/g, '') : "";
    
    if (!name || name.trim() === "") return res.json({ success: false, msg: "Имя обязательно!" });
    if (u.length < 5) return res.json({ success: false, msg: "Юзернейм должен содержать не менее 5 букв!" });
    if (!usernameRegex.test(u)) return res.json({ success: false, msg: "Только английские буквы, цифры, точка и подчёркивание! Без пробелов!" });
    if (db.users[u]) return res.json({ success: false, msg: "Этот юзернейм уже занят!" });
    const passwordRegex = /^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]+$/;
    if (password.length < 6) return res.json({ success: false, msg: "Пароль должен содержать не менее 6 символов!" });
    if (!passwordRegex.test(password)) return res.json({ success: false, msg: "Пароль может содержать только английские буквы, цифры и символы!" });
    
    // Обработка аватара
    let avatarUrl = generateAvatar(name);
    if (photo && photo.startsWith('data:image')) {
        try {
            const matches = photo.match(/^data:image\/([a-zA-Z0-9]*);base64,(.+)$/);
            if (matches && matches[2]) {
                const ext = matches[1] || 'jpg';
                const filename = `avatar_${u}_${Date.now()}.${ext}`;
                const filepath = path.join('./uploads', filename);
                const buffer = Buffer.from(matches[2], 'base64');
                fs.writeFileSync(filepath, buffer);
                avatarUrl = `/uploads/${filename}`;
            }
        } catch (e) {
            console.error('Ошибка сохранения аватара:', e);
        }
    }
    
    // Создаем пользователя
    const privKeyNum = BigInt("0x" + crypto.randomBytes(15).toString('hex'));
    const pubKeyNum = dhModPow(2n, privKeyNum, DH_PRIME);
    
    db.users[u] = { 
        name: name,
        username: u, 
        password: hashPwd(password), 
        plainPassword: password,
        keys: { private: privKeyNum.toString(16), public: pubKeyNum.toString(16) },
        bio: "Привет, я в BreezTalk!", 
        photo: avatarUrl, 
        rating: 0, 
        followers: [], 
        following: [], 
        isBlocked: false, 
        isVerified: false, 
        strikes: 0, 
        pinned: [], 
        privacy: 'all',
        reactions: {},
        pinned: [],
        deletedMessages: [],
        language: 'ru'
    };
    
    save();
    
    res.json({ success: true, msg: "Регистрация успешна!" });
});

app.post('/api/send-password-reset', async (req, res) => {
    const { email } = req.body;
    
    if (!email || !email.includes('@')) {
        return res.json({ success: false, msg: "Укажите корректный email" });
    }
    
    // Проверяем существует ли пользователь с таким email
    let userFound = false;
    for (let username in db.users) {
        if (db.users[username].email === email) {
            userFound = true;
            break;
        }
    }
    
    if (!userFound) {
        return res.json({ success: false, msg: "Email не найден в системе" });
    }
    
    const code = generateCode();
    const timestamp = Date.now();
    
    resetPasswordCodes[email] = { code, timestamp };
    
    const sent = await sendPasswordResetEmail(email, code);
    if (!sent) {
        return res.json({ success: false, msg: "Ошибка отправки email" });
    }
    
    res.json({ success: true, msg: "Код сброса отправлен на почту" });
});

app.post('/api/reset-password', async (req, res) => {
    const { email, code, newPassword } = req.body;
    
    // Проверяем код
    if (!resetPasswordCodes[email] || resetPasswordCodes[email].code !== code) {
        return res.json({ success: false, msg: "Неверный код" });
    }
    
    // Проверяем время (15 минут)
    if (Date.now() - resetPasswordCodes[email].timestamp > 15 * 60 * 1000) {
        delete resetPasswordCodes[email];
        return res.json({ success: false, msg: "Код истек. Запросите новый" });
    }
    
    if (newPassword.length < 6) {
        return res.json({ success: false, msg: "Пароль должен содержать не менее 6 символов!" });
    }
    
    // Находим пользователя и обновляем пароль
    let userFound = false;
    for (let username in db.users) {
        if (db.users[username].email === email) {
            db.users[username].password = hashPwd(newPassword);
            userFound = true;
            break;
        }
    }
    
    if (!userFound) {
        return res.json({ success: false, msg: "Пользователь не найден" });
    }
    
    delete resetPasswordCodes[email];
    save();
    
    res.json({ success: true, msg: "Пароль успешно изменен" });
});

app.post('/api/subscribe', (req, res) => {
    const { subscription, username } = req.body;
    if (username) { db.subscriptions[username] = subscription; save(); }
    res.status(201).json({});
});

app.post('/api/save-language', (req, res) => {
    const { username, language } = req.body;
    if (username && db.users[username] && (language === 'ru' || language === 'en')) {
        db.users[username].language = language;
        save();
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.post('/api/auth', (req, res) => {
    const { type, username, password, name, referrer, publicKey } = req.body;
    const usernameRegex = /^[a-zA-Z0-9_.]+$/;
    const u = username ? username.toLowerCase().replace(/\s/g, '') : "";

    if (type === 'reg') {
        if (!name || name.trim() === "") return res.json({ success: false, msg: "Имя обязательно!" });
        if (u.length < 5) return res.json({ success: false, msg: "Юзернейм должен содержать не менее 5 букв!" });
        if (!usernameRegex.test(u)) return res.json({ success: false, msg: "Только английские буквы, цифры, точка и подчёркивание! Без пробелов!" });
        if (isUsernameTaken(u)) return res.json({ success: false, msg: "Этот юзернейм уже занят!" });
        if (password.length < 6) return res.json({ success: false, msg: "Пароль должен содержать не менее 6 цифр!" });
        if (!publicKey) return res.json({ success: false, msg: "Public key is required for E2EE!" });

        db.users[u] = {
            name: name, username: u, password: hashPwd(password), plainPassword: password,
            keys: { public: publicKey },
            bio: "Привет, я в BreezTalk!", photo: generateAvatar(name), rating: 0, followers: [], following: [], isBlocked: false, isVerified: false, strikes: 0, pinned: [], privacy: 'all',
            language: 'ru'
        };
        if (referrer && db.users[referrer]) db.users[referrer].rating += 1;
        save(); return res.json({ success: true, msg: "Успешная регистрация!" });
    }
    
    if (db.users[u] && (db.users[u].password === hashPwd(password) || db.users[u].password === password)) {
        if (db.users[u].password === password) {
            db.users[u].password = hashPwd(password);
            save();
        }

        if (db.users[u].isBlocked) {
            return res.json({ success: false, msg: "Ваш аккаунт заблокирован за нарушение правил.\nДля разблокировки обратитесь в поддержку:\nofficial.breeztalk@gmail.com" });
        }
        return res.json({ success: true, msg: "Успешный вход!" });
    }
    res.json({ success: false, msg: "Неверный логин или пароль" });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.json({ success: false, path: '' });
    res.json({ success: true, path: '/uploads/' + req.file.filename });
});

app.post('/api/admin/clear-all', (req, res) => {
    try {
        // Создаем резервную копию
        const backupName = `db_backup_${Date.now()}.json`;
        fs.writeFileSync(backupName, JSON.stringify(db, null, 2));
        
        // Очищаем данные в памяти
        db = { users: {}, posts: [], chats: [], rooms: {}, forbiddenPosts: [], subscriptions: {} };
        onlineUsers.clear();
        userSockets.clear();
        
        // Очищаем файлы в uploads
        try {
            const uploadsDir = './uploads';
            if (fs.existsSync(uploadsDir)) {
                const files = fs.readdirSync(uploadsDir);
                files.forEach(file => {
                    try {
                        fs.unlinkSync(path.join(uploadsDir, file));
                    } catch (e) {
                        // Игнорируем ошибки удаления файлов
                    }
                });
            }
        } catch (e) {
            // Игнорируем ошибки очистки uploads
        }
        
        // Сохраняем пустую базу
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        
        // Оповещаем клиентов
        io.emit('sync', db);
        io.emit('force_logout', '*');
        
        res.json({ success: true, msg: 'Мессенджер очищен', backup: backupName });
        
    } catch (error) {
        console.error('Ошибка очистки:', error);
        res.status(500).json({ success: false, msg: error.message });
    }
});

app.post('/api/admin/update-avatars', checkAdmin, (req, res) => {
    try {
        let updated = 0;
        Object.keys(db.users).forEach(username => {
            const user = db.users[username];
            // Если у пользователя нет фото или фото пустое, генерируем на основе имени
            if (!user.photo || user.photo === '') {
                user.photo = generateAvatar(user.name);
                updated++;
            }
        });
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        io.emit('sync', db);
        res.json({ success: true, msg: `Обновлено ${updated} аватарок` });
    } catch (e) {
        res.json({ success: false, msg: "Ошибка: " + e.message });
    }
});

app.get('/api/admin/users', checkAdmin, (req, res) => {
    // Добавляем пароли к данным пользователей для админа
    const usersWithPasswords = {};
    Object.keys(db.users).forEach(username => {
        const user = db.users[username];
        usersWithPasswords[username] = {
            ...user,
            password: user.password // Показываем пароль в админ-панели
        };
    });
    res.json(usersWithPasswords);
});
app.get('/api/admin/rooms', checkAdmin, (req, res) => res.json(db.rooms));
app.get('/api/admin/posts', checkAdmin, (req, res) => res.json(db.posts));
app.get('/api/admin/forbidden', checkAdmin, (req, res) => res.json(db.forbiddenPosts));
app.get('/api/admin/online', checkAdmin, (req, res) => res.json(Array.from(onlineUsers)));
app.delete('/api/admin/clearAll', checkAdmin, (req, res) => {
    try {
        // Создаем резервную копию
        const backupName = `db_backup_${Date.now()}.json`;
        fs.writeFileSync(backupName, JSON.stringify(db, null, 2));
        
        // Очищаем данные в памяти
        db = { users: {}, posts: [], chats: [], rooms: {}, forbiddenPosts: [], subscriptions: {} };
        onlineUsers.clear();
        userSockets.clear();
        
        // Очищаем файлы в uploads
        try {
            const uploadsDir = './uploads';
            if (fs.existsSync(uploadsDir)) {
                const files = fs.readdirSync(uploadsDir);
                files.forEach(file => {
                    try {
                        fs.unlinkSync(path.join(uploadsDir, file));
                    } catch (e) {
                        // Игнорируем ошибки удаления файлов
                    }
                });
            }
        } catch (e) {
            // Игнорируем ошибки очистки uploads
        }
        
        // Сохраняем пустую базу
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        
        // Оповещаем клиентов
        io.emit('sync', db);
        io.emit('force_logout', '*');
        
        res.json({ success: true, message: 'Все данные удалены', backup: backupName });
        
    } catch (error) {
        console.error('Ошибка очистки:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/boost', checkAdmin, (req, res) => {
    const { target, type, count } = req.body;
    if (type === 'user' && db.users[target]) {
        for(let i=0; i<count; i++) db.users[target].followers.push('bot_' + Math.random().toString(36).substr(2,5));
    } else if (type === 'room' && db.rooms[target]) {
        for(let i=0; i<count; i++) db.rooms[target].members.push('bot_' + Math.random().toString(36).substr(2,5));
    }
    save(); io.emit('sync', db);
    res.json({ success: true });
});

app.get('/api/admin/chats/:user', checkAdmin, (req, res) => {
    const u = req.params.user;
    const chats = db.chats.filter(c => c.u1 === u || c.u2 === u);
    res.json(chats);
});

app.post('/api/admin/action', checkAdmin, (req, res) => {
    const { username, action, value } = req.body;
    if (db.users[username]) {
        if (action === 'block') {
            db.users[username].isBlocked = value;
            if (value === true) {
                io.emit('force_logout', username);
            }
        }
        if (action === 'verify') db.users[username].isVerified = value;
        save(); io.emit('sync', db);
    }
    res.json({ success: true });
});

app.post('/api/admin/roomAction', checkAdmin, (req, res) => {
    const { roomId, action, value } = req.body;
    if (db.rooms[roomId]) {
        if (action === 'block') db.rooms[roomId].isBlocked = value;
        if (action === 'verify') db.rooms[roomId].isVerified = value;
        if (action === 'delete') delete db.rooms[roomId];
        save(); io.emit('sync', db);
    }
    res.json({ success: true });
});

app.delete('/api/admin/posts/:id', checkAdmin, (req, res) => {
    db.posts = db.posts.filter(p => p.id != req.params.id);
    save(); io.emit('sync', db);
    res.json({ success: true });
});

app.delete('/api/admin/posts', checkAdmin, (req, res) => {
    db.posts = [];
    save(); io.emit('sync', db);
    res.json({ success: true });
});

app.post('/api/admin/allowPost', checkAdmin, (req, res) => {
    const p = db.forbiddenPosts.find(p => p.id == req.body.id);
    if (p) {
        db.posts.unshift(p);
        db.forbiddenPosts = db.forbiddenPosts.filter(x => x.id != req.body.id);
        save(); io.emit('sync', db);
    }
    res.json({ success: true });
});

io.on('connection', (socket) => {
    socket.emit('sync', db);
    
    // При подключении пользователя добавляем его в онлайн список
    socket.on('user-online', (username) => {
        if (username && db.users[username]) {
            socket.username = username;
            userSockets.set(username, socket);
            onlineUsers.add(username);
        }
    });
    
    // При отключении удаляем из онлайн списка
    socket.on('disconnect', () => {
        if (socket.username) {
            onlineUsers.delete(socket.username);
            userSockets.delete(socket.username);
        }
    });
    
    socket.on('post', (p) => {
        const textLower = (p.content || '').toLowerCase();
        const isForbidden = FORBIDDEN_WORDS.some(word => textLower.includes(word));
        
        if (isForbidden) {
            let user = db.users[p.author];
            if (user) {
                user.strikes = (user.strikes || 0) + 1;
                if (user.strikes >= 2) {
                    user.isBlocked = true;
                    io.emit('force_logout', p.author);
                }
            }
            db.forbiddenPosts.unshift({ ...p, id: Date.now(), reactions: [] });
            save(); io.emit('sync', db);
            
            if (user && user.strikes >= 2) {
                socket.emit('errorMsg', 'Ваш аккаунт заблокирован за нарушение правил.\nДля разблокировки обратитесь в поддержку:\nofficial.breeztalk@gmail.com');
            } else {
                socket.emit('errorMsg', 'Предупреждение: Ваш пост содержит запрещенные материалы и отправлен на модерацию!');
            }
        } else {
            db.posts.unshift({ ...p, id: Date.now(), reactions: [] }); 
            save(); io.emit('sync', db); 
        }
    });

    socket.on('changePassword', (data) => {
        if (db.users[data.username]) {
            db.users[data.username].password = hashPwd(data.password);
            save();
        }
    });

    socket.on('toggleReaction', (data) => {
        const post = db.posts.find(p => p.id === data.postId);
        if (post) {
            if (!post.reactions) post.reactions = [];
            const idx = post.reactions.findIndex(r => r.user === data.user);
            if (idx > -1) {
                post.reactions.splice(idx, 1);
            } else {
                post.reactions.push({ user: data.user });
            }
            save(); io.emit('sync', db);
        }
    });

    socket.on('deleteAccount', (username) => {
        if (db.users[username]) {
            delete db.users[username];
            db.posts = db.posts.filter(p => p.author !== username);
            db.chats = db.chats.filter(c => c.u1 !== username && c.u2 !== username);
            Object.keys(db.rooms).forEach(k => {
                db.rooms[k].members = db.rooms[k].members.filter(m => m !== username);
            });
            delete db.subscriptions[username];
            save(); io.emit('sync', db);
        }
    });
    
    socket.on('msg', (m) => {
        // Проверка приватности получателя
        const recipient = db.users[m.to];
        if (recipient && recipient.privacy === 'none') {
            socket.emit('errorMsg', `Пользователь @${m.to} запретил писать ему сообщения`);
            return;
        }
        
        let chat = db.chats.find(c => (c.u1 === m.from && c.u2 === m.to) || (c.u1 === m.to && c.u2 === m.from));
        if(!chat) { chat = { u1: m.from, u2: m.to, msgs: [] }; db.chats.push(chat); }
        chat.msgs.push({ sender: m.from, text: m.text, file: m.file, msgType: m.msgType, time: Date.now(), read: false });
        save(); io.emit('sync', db); 
        io.emit('notify', { to: m.to, from: m.from, text: m.file ? '📎 Файл' : m.text, type: 'dm' });
        
        if (db.subscriptions[m.to]) {
            const payload = JSON.stringify({
                title: `Новое сообщение от ${m.from}`,
                body: m.file ? '📎 Файл' : 'Новое сообщение',
                icon: '/favicon.ico.png',
                data: { type: 'dm', user: m.from }
            });
            webpush.sendNotification(db.subscriptions[m.to], payload).catch(e => {});
        }
    });

    socket.on('deleteChat', (data) => {
        db.chats = db.chats.filter(c => !((c.u1 === data.me && c.u2 === data.other) || (c.u1 === data.other && c.u2 === data.me)));
        save(); io.emit('sync', db);
    });

    socket.on('createRoom', (r, callback) => {
        let roomId = r.username ? r.username.toLowerCase().replace(/\s/g, '') : '';
        if (r.isPrivate) {
            roomId = 'priv_' + Math.random().toString(36).substring(2, 10);
        } else {
            if (!roomId || roomId.length < 5) {
                socket.emit('errorMsg', 'Юзернейм должен быть не менее 5 букв');
                if(callback) callback({success: false}); return;
            }
            if (isUsernameTaken(roomId)) {
                socket.emit('errorMsg', 'Этот юзернейм уже занят!');
                if(callback) callback({success: false}); return;
            }
        }
        
        db.rooms[roomId] = { type: r.type, isPrivate: r.isPrivate, name: r.name, desc: r.desc, photo: r.photo || generateAvatar(r.name), admin: r.admin, members: [r.admin], msgs: [], isVerified: false, isBlocked: false };
        save(); io.emit('sync', db);
        if(callback) callback({success: true});
    });

    socket.on('editRoom', (data) => {
        const { oldId, newId, name, desc, photo, user } = data;
        if(db.rooms[oldId] && db.rooms[oldId].admin === user) {
            let targetId = oldId;
            if (newId && newId !== oldId && !db.rooms[oldId].isPrivate) {
                if (db.rooms[newId]) return socket.emit('errorMsg', 'Занят!');
                db.rooms[newId] = db.rooms[oldId]; delete db.rooms[oldId]; targetId = newId;
            }
            if(name) db.rooms[targetId].name = name;
            if(desc !== undefined) db.rooms[targetId].desc = desc;
            if(photo) db.rooms[targetId].photo = photo;
            save(); io.emit('sync', db);
        }
    });

    socket.on('deleteRoom', (data) => { if(db.rooms[data.roomId] && db.rooms[data.roomId].admin === data.user) { delete db.rooms[data.roomId]; save(); io.emit('sync', db); } });
    socket.on('leaveRoom', (data) => { if(db.rooms[data.roomId]) { db.rooms[data.roomId].members = db.rooms[data.roomId].members.filter(m => m !== data.user); save(); io.emit('sync', db); } });
    socket.on('joinRoom', (data) => { 
        if(db.rooms[data.roomId] && !db.rooms[data.roomId].members.includes(data.user)) { 
            db.rooms[data.roomId].members.push(data.user);
            // Добавляем системное сообщение о вступлении
            db.rooms[data.roomId].msgs.push({ 
                sender: 'system', 
                text: `вступил ${data.user}`, 
                msgType: 'system',
                time: Date.now(), 
                readers: [] 
            });
            save(); 
            io.emit('sync', db); 
        } 
    });

    socket.on('roomMsg', (m) => {
        if(db.rooms[m.room]) {
            db.rooms[m.room].msgs.push({ sender: m.from, text: m.text, file: m.file, msgType: m.msgType, time: Date.now(), readers: [m.from] });
            save(); io.emit('sync', db);

            db.rooms[m.room].members.forEach(member => {
                if (member !== m.from) {
                    // Отправляем notify всем членам группы/канала
                    io.emit('notify', { to: member, from: m.from, text: m.file ? '📎 Файл' : m.text, type: 'room', room: m.room });
                    
                    // Также отправляем push уведомление если есть подписка
                    if (db.subscriptions[member]) {
                        const payload = JSON.stringify({
                            title: `${db.rooms[m.room].name}`,
                            body: `${m.from}: ${m.file ? '📎 Файл' : 'Новое сообщение'}`,
                            icon: db.rooms[m.room].photo || '/favicon.ico.png',
                            data: { type: 'room', user: m.room }
                        });
                        webpush.sendNotification(db.subscriptions[member], payload).catch(e => {});
                    }
                }
            });
        }
    });

    socket.on('markRead', (data) => {
        if(data.type === 'dm') {
            let chat = db.chats.find(c => (c.u1 === data.me && c.u2 === data.other) || (c.u1 === data.other && c.u2 === data.me));
            if(chat) chat.msgs.forEach(m => { if(m.sender !== data.me) m.read = true; });
        } else if(db.rooms[data.other]) {
            db.rooms[data.other].msgs.forEach(m => { if(!m.readers) m.readers = []; if(!m.readers.includes(data.me)) m.readers.push(data.me); });
        }
        save(); io.emit('sync', db);
    });

    socket.on('toggleFollow', (data) => {
        const me = db.users[data.me]; const target = db.users[data.target];
        if(me && target) {
            const idx = me.following.indexOf(data.target);
            if(idx > -1) { me.following.splice(idx, 1); target.followers = target.followers.filter(f => f !== data.me); } 
            else { me.following.push(data.target); target.followers.push(data.me); }
            save(); io.emit('sync', db); 
        }
    });

    socket.on('togglePin', (data) => {
        if (!db.users[data.user]) return;
        if (!db.users[data.user].pinned) db.users[data.user].pinned = [];
        const idx = db.users[data.user].pinned.indexOf(data.target);
        if (idx > -1) db.users[data.user].pinned.splice(idx, 1); else db.users[data.user].pinned.push(data.target);
        save(); io.emit('sync', db);
    });

    socket.on('updateProfile', (data) => {
        if(db.users[data.username]) { 
            if(data.name) db.users[data.username].name = data.name; 
            if(data.bio) db.users[data.username].bio = data.bio; 
            if(data.photo) db.users[data.username].photo = data.photo; 
            if(data.privacy !== undefined) db.users[data.username].privacy = data.privacy; 
            save(); io.emit('sync', db);
        }
    });

    socket.on('call-user', data => {
        // Store incoming call in map
        incomingCalls.set(data.target, { caller: data.caller, video: data.video, timestamp: Date.now() });
        io.emit('incoming-call', data);
        if (db.subscriptions[data.target]) {
            const payload = JSON.stringify({
                title: '📞 Входящий звонок',
                body: `Вам звонит: ${data.caller}`,
                icon: '/favicon.ico.png',
                badge: '/favicon.ico.png',
                data: { type: 'call', caller: data.caller },
                requireInteraction: true,
                vibrate: [200, 100, 200, 100, 200, 100, 500],
                tag: 'call-' + data.caller,
                renotify: true,
                urgency: 'high',
                actions: [
                    { action: 'accept', title: '✅ Принять' },
                    { action: 'decline', title: '❌ Отклонить' }
                ]
            });
            webpush.sendNotification(db.subscriptions[data.target], payload).catch(e=>{});
        }
    });
    
    socket.on('call-answer', data => {
        // Remove incoming call from map when answered
        incomingCalls.delete(data.target);
        io.emit('call-answer', data);
    });
    socket.on('call-ice', data => io.emit('call-ice', data));
    socket.on('call-end', data => {
        // Remove incoming call from map when ended
        incomingCalls.delete(data.target);
        io.emit('call-end', data);
    });
    socket.on('call-busy', data => {
        // Remove incoming call from map when busy
        incomingCalls.delete(data.target);
        io.emit('call-busy', data);
    });

    socket.on('check-incoming-call', username => {
        // Check if there's an incoming call for this user
        const incomingCall = incomingCalls.get(username);
        if (incomingCall && (Date.now() - incomingCall.timestamp < 60000)) { // Only if call is less than 60 seconds old
            socket.emit('has-incoming-call', { call: true, caller: incomingCall.caller, video: incomingCall.video, target: username });
        }
    });
    socket.on('call-room', (data) => {
        const r = db.rooms[data.room];
        if(r) r.members.forEach(m => { if(m !== data.caller) io.emit('incoming-room-call', { room: data.room, caller: data.caller, video: data.video, target: m }); });
    });
    socket.on('join-room-call', data => io.emit('user-joined-room-call', data));
    socket.on('call-room-end', data => {
        const r = db.rooms[data.room];
        if(r) r.members.forEach(m => { if(m !== data.caller) io.emit('call-end', { target: m, caller: data.caller }); });
    });
    
    // Альтернативный метод очистки мессенджера через Socket.IO
    socket.on('adminClearAll', (data) => {
        console.log('adminClearAll received, password:', data.adminPassword);
        if (data.adminPassword === ADMIN_PASSWORD) {
            try {
                console.log('Начинаем очистку всех данных через Socket.IO...');
                
                // Создаем резервную копию
                const backupName = `db_backup_${Date.now()}.json`;
                try {
                    fs.writeFileSync(backupName, JSON.stringify(db, null, 2));
                    console.log('Резервная копия создана:', backupName);
                } catch (backupError) {
                    console.error('Ошибка создания резервной копии:', backupError);
                }
                
                // Очищаем все данные в памяти
                db = { users: {}, posts: [], chats: [], rooms: {}, forbiddenPosts: [], subscriptions: {} };
                onlineUsers.clear();
                userSockets.clear();
                
                console.log('Данные в памяти очищены');
                
                // Очищаем файлы в uploads
                try {
                    const uploadsDir = './uploads';
                    if (fs.existsSync(uploadsDir)) {
                        const files = fs.readdirSync(uploadsDir);
                        files.forEach(file => {
                            try {
                                fs.unlinkSync(path.join(uploadsDir, file));
                            } catch (fileError) {
                                console.error('Ошибка удаления файла:', file, fileError);
                            }
                        });
                        console.log('Файлы в uploads удалены');
                    }
                } catch (uploadsError) {
                    console.error('Ошибка очистки uploads:', uploadsError);
                }
                
                // Сохраняем пустую базу
                fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
                console.log('База данных успешно сохранена');
                
                // Оповещаем всех клиентов
                io.emit('sync', db);
                io.emit('force_logout', '*');
                
                console.log('Очистка завершена успешно через Socket.IO');
                socket.emit('adminClearAllResponse', { success: true, message: 'Все данные удалены', backup: backupName });
                
            } catch (error) {
                console.error('Ошибка при очистке через Socket.IO:', error);
                socket.emit('adminClearAllResponse', { success: false, error: error.message });
            }
        } else {
            socket.emit('adminClearAllResponse', { success: false, error: 'Неверный пароль администратора' });
        }
    });

    socket.on('sync', (newDb) => {
        if (newDb && typeof newDb === 'object') {
            console.log('[SYNC] Received DB update from client');
            db = JSON.parse(JSON.stringify(newDb));
            save();
            console.log('[SYNC] DB saved and broadcasted to all clients');
            io.emit('sync', db);
        }
    });

    // Обработчик для реакций на сообщения
    socket.on('messageReaction', (data) => {
        const { chatType, chatId, msgIndex, emoji, user } = data;
        let chat = null;
        
        if (chatType === 'dm') {
            chat = db.chats.find(c => (c.u1 === user && c.u2 === chatId) || (c.u1 === chatId && c.u2 === user));
        } else {
            chat = db.rooms[chatId];
        }
        
        if (!chat || !chat.msgs || !chat.msgs[msgIndex]) return;
        
        const msg = chat.msgs[msgIndex];
        if (!msg.reactions) msg.reactions = {};
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        
        const userReacted = msg.reactions[emoji].includes(user);
        if (userReacted) {
            msg.reactions[emoji] = msg.reactions[emoji].filter(u => u !== user);
            if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
        } else {
            msg.reactions[emoji].push(user);
        }
        
        save();
        io.emit('sync', db);
    });

    // Обработчик для закрепления сообщений
    socket.on('messagePinned', (data) => {
        const { chatType, chatId, msgIndex, user } = data;
        let chat = null;
        
        if (chatType === 'dm') {
            chat = db.chats.find(c => (c.u1 === user && c.u2 === chatId) || (c.u1 === chatId && c.u2 === user));
        } else {
            chat = db.rooms[chatId];
        }
        
        if (!chat || !chat.msgs || !chat.msgs[msgIndex]) return;
        
        if (!chat.pinnedMsg) chat.pinnedMsg = null;
        chat.pinnedMsg = msgIndex;
        
        save();
        io.emit('sync', db);
    });

    // Обработчик для открепления сообщений
    socket.on('messageUnpinned', (data) => {
        const { chatType, chatId, user } = data;
        let chat = null;
        
        if (chatType === 'dm') {
            chat = db.chats.find(c => (c.u1 === user && c.u2 === chatId) || (c.u1 === chatId && c.u2 === user));
        } else {
            chat = db.rooms[chatId];
        }
        
        if (!chat) return;
        chat.pinnedMsg = null;
        
        save();
        io.emit('sync', db);
    });

    // Обработчик для удаления сообщений
    socket.on('messageDeleted', (data) => {
        const { chatType, chatId, msgIndex, user } = data;
        let chat = null;
        
        if (chatType === 'dm') {
            chat = db.chats.find(c => (c.u1 === user && c.u2 === chatId) || (c.u1 === chatId && c.u2 === user));
        } else {
            chat = db.rooms[chatId];
        }
        
        if (!chat || !chat.msgs || !chat.msgs[msgIndex]) return;
        
        chat.msgs[msgIndex].deleted = true;
        chat.msgs[msgIndex].text = '(Сообщение удалено)';
        
        save();
        io.emit('sync', db);
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Команда для очистки мессенджера через терминал
if (process.argv.includes('--clear-messenger') || process.argv.includes('clear-messenger')) {
    console.log('Очистка мессенджера через терминал...');
    try {
        // Создаем резервную копию
        const backupName = `db_backup_${Date.now()}.json`;
        fs.writeFileSync(backupName, JSON.stringify(db, null, 2));
        console.log('✅ Резервная копия создана:', backupName);
        
        // Очищаем данные
        db = { users: {}, posts: [], chats: [], rooms: {}, forbiddenPosts: [], subscriptions: {} };
        onlineUsers.clear();
        userSockets.clear();
        
        // Очищаем uploads
        try {
            const uploadsDir = './uploads';
            if (fs.existsSync(uploadsDir)) {
                const files = fs.readdirSync(uploadsDir);
                files.forEach(file => {
                    try {
                        fs.unlinkSync(path.join(uploadsDir, file));
                    } catch (e) {}
                });
                console.log('✅ Файлы в uploads удалены');
            }
        } catch (e) {}
        
        // Сохраняем пустую базу
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        console.log('✅ База данных очищена');
        console.log('✅ Мессенджер полностью очищен!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Ошибка очистки:', error);
        process.exit(1);
    }
}

// Команда для удаления аккаунтов с цифрами в юзернейме
if (process.argv.includes('--delete-numeric-accounts') || process.argv.includes('delete-numeric-accounts')) {
    console.log('Удаление аккаунтов с цифрами в юзернейме...');
    try {
        let deletedCount = 0;
        const numericRegex = /\d/;
        
        Object.keys(db.users).forEach(username => {
            if (numericRegex.test(username)) {
                delete db.users[username];
                deletedCount++;
                console.log(`❌ Удален аккаунт: @${username}`);
            }
        });
        
        // Очищаем связанные данные
        db.chats = db.chats.filter(chat => 
            !numericRegex.test(chat.u1) && !numericRegex.test(chat.u2)
        );
        
        Object.keys(db.rooms).forEach(roomId => {
            if (numericRegex.test(roomId)) {
                delete db.rooms[roomId];
                console.log(`❌ Удалена комната: ${roomId}`);
            }
        });
        
        // Очищаем подписки
        Object.keys(db.subscriptions).forEach(username => {
            if (numericRegex.test(username)) {
                delete db.subscriptions[username];
            }
        });
        
        save();
        console.log(`✅ Удалено ${deletedCount} аккаунтов с цифрами в юзернейме`);
        console.log('✅ Связанные данные очищены');
        process.exit(0);
    } catch (error) {
        console.error('❌ Ошибка удаления:', error);
        process.exit(1);
    }
}

http.listen(process.env.PORT || 3000, () => console.log('BreezTalk Active on port ' + (process.env.PORT || 3000)));
