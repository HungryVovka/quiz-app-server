const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const APP_PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'server_db');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const LEAGUE_FILE = path.join(DATA_DIR, 'league_state.json');

const CLIENT_DIR = path.join(__dirname, '..');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const INITIAL_USERS = [
    {
        id: 'u_admin_001',
        username: 'SuperAdmin',
        role: 'admin',
        profileKey: 'FOX-ADM-9999-SUPER',
        passwordHash: 'admin123',
        avatar: 'assets/icon.png',
        xp: 0,
        weeklyXP: 0,
        unlockedAvatars: ['assets/icon.png', 'assets/avatar_fox_crown.png']
    },
    {
        id: 'u_user_001',
        username: 'AlexFox',
        role: 'user',
        profileKey: 'FOX-USR-1001-KEY',
        passwordHash: 'pass123',
        avatar: 'assets/icon.png',
        xp: 0,
        weeklyXP: 0,
        unlockedAvatars: ['assets/icon.png']
    }
];

if (!fs.existsSync(USERS_FILE) || fs.readFileSync(USERS_FILE, 'utf8').trim() === '[]') {
    fs.writeFileSync(USERS_FILE, JSON.stringify(INITIAL_USERS, null, 2), 'utf8');
}
if (!fs.existsSync(STATS_FILE)) fs.writeFileSync(STATS_FILE, JSON.stringify({}), 'utf8');
if (!fs.existsSync(CHAT_FILE)) fs.writeFileSync(CHAT_FILE, JSON.stringify([]), 'utf8');
if (!fs.existsSync(LEAGUE_FILE)) fs.writeFileSync(LEAGUE_FILE, JSON.stringify({ lastResetWeek: null }), 'utf8');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.use(express.static(CLIENT_DIR));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST', 'DELETE'] }
});

function loadJSON(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        if (filePath.endsWith('chat.json')) return [];
        if (filePath.endsWith('users.json')) return [];
        return {};
    }
}

function saveJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function sanitizeUser(user) {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        profileKey: user.profileKey,
        avatar: user.avatar || 'assets/icon.png',
        xp: user.xp || 0,
        weeklyXP: user.weeklyXP || 0,
        unlockedAvatars: user.unlockedAvatars || ['assets/icon.png']
    };
}

// Проверка администратора по токену / ID / profileKey
function verifyAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Авторизация отсутствует' });

    const token = authHeader.replace('Bearer ', '').trim();
    const users = loadJSON(USERS_FILE);
    const admin = users.find(u => (u.id === token || u.profileKey === token) && u.role === 'admin');

    if (!admin) {
        return res.status(403).json({ error: 'Доступ запрещен. Требуются права администратора.' });
    }
    req.adminUser = admin;
    next();
}

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', online: true }));

// Вход по логину/паролю
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните логин и пароль' });

    const users = loadJSON(USERS_FILE);
    const user = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase() && u.passwordHash === password);

    if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });

    return res.json({ success: true, user: sanitizeUser(user) });
});

// Регистрация
app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    const cleanUsername = (username || '').trim();

    if (!cleanUsername || !password) return res.status(400).json({ error: 'Заполните все поля' });

    const users = loadJSON(USERS_FILE);
    if (users.some(u => u.username.toLowerCase() === cleanUsername.toLowerCase())) {
        return res.status(400).json({ error: 'Пользователь с таким именем уже существует' });
    }

    const newId = 'u_' + Date.now();
    const newKey = 'FOX-USR-' + Math.floor(1000 + Math.random() * 9000) + '-KEY';

    const newUser = {
        id: newId,
        username: cleanUsername,
        role: 'user',
        profileKey: newKey,
        passwordHash: password,
        avatar: 'assets/icon.png',
        xp: 0,
        weeklyXP: 0,
        unlockedAvatars: ['assets/icon.png']
    };

    users.push(newUser);
    saveJSON(USERS_FILE, users);

    return res.json({ success: true, user: sanitizeUser(newUser) });
});

// Вход по ключу
app.post('/api/auth/admin-key', (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'Не указан ключ' });

    const users = loadJSON(USERS_FILE);
    const user = users.find(u => u.profileKey === key.trim() || u.id === key.trim());

    if (!user) return res.status(404).json({ error: 'Неверный ключ профиля' });

    return res.json({ success: true, user: sanitizeUser(user) });
});

// Прямое начисление XP за правильные ответы (по 1 XP за каждый верный ответ)
app.post('/api/user/add-xp', (req, res) => {
    const { userId, amount } = req.body;
    if (!userId) return res.status(400).json({ error: 'Не указан ID пользователя' });

    const xpToAdd = parseInt(amount, 10) || 1;
    const users = loadJSON(USERS_FILE);
    const uIdx = users.findIndex(u => u.id === userId || u.profileKey === userId);

    if (uIdx !== -1) {
        users[uIdx].xp = (users[uIdx].xp || 0) + xpToAdd;
        users[uIdx].weeklyXP = (users[uIdx].weeklyXP || 0) + xpToAdd;
        saveJSON(USERS_FILE, users);
        return res.json({ success: true, user: sanitizeUser(users[uIdx]) });
    }

    return res.status(404).json({ error: 'Пользователь не найден' });
});

// Получение статистики
app.get('/api/stats/:key', (req, res) => {
    const { key } = req.params;
    const allStats = loadJSON(STATS_FILE);
    const users = loadJSON(USERS_FILE);

    const user = users.find(u => u.profileKey === key || u.id === key);
    const userKey = user ? user.profileKey : key;

    res.json(allStats[userKey] || allStats[key] || {});
});

// Сохранение аналитической статистики (без перетирания XP пользователя)
app.post('/api/stats/:key', (req, res) => {
    const { key } = req.params;
    const clientStats = req.body || {};

    const users = loadJSON(USERS_FILE);
    const user = users.find(u => u.profileKey === key || u.id === key);
    const targetKey = user ? user.profileKey : key;

    const allStats = loadJSON(STATS_FILE);
    const currentStats = allStats[targetKey] || {};

    const merged = { ...currentStats };
    merged.totalQuizzes = (currentStats.totalQuizzes || 0) + (clientStats.totalQuizzes || 0);
    merged.correctAnswers = (currentStats.correctAnswers || 0) + (clientStats.correctAnswers || 0);

    for (const [qId, qStat] of Object.entries(clientStats)) {
        if (typeof qStat === 'object' && qStat && qStat.attempts !== undefined) {
            if (!merged[qId]) {
                merged[qId] = { ...qStat };
            } else {
                merged[qId].attempts = Math.max(merged[qId].attempts || 0, qStat.attempts || 0);
                merged[qId].correct = Math.max(merged[qId].correct || 0, qStat.correct || 0);
            }
        }
    }

    allStats[targetKey] = merged;
    saveJSON(STATS_FILE, allStats);

    const updatedUser = user ? sanitizeUser(user) : null;
    res.json({ success: true, stats: merged, user: updatedUser });
});

// Таблица лидеров Лиги
app.get('/api/league/top', (req, res) => {
    const users = loadJSON(USERS_FILE);
    const leaderboard = users
        .map(u => ({
            id: u.id,
            username: u.username,
            avatar: u.avatar || 'assets/icon.png',
            xp: u.xp || 0,
            weeklyXP: u.weeklyXP || 0,
            role: u.role
        }))
        .sort((a, b) => (b.weeklyXP || b.xp) - (a.weeklyXP || a.xp));

    res.json(leaderboard);
});

// --- АДМИНИСТРАТИВНЫЙ ФУНКЦИОНАЛ ---
app.get('/api/admin/users', verifyAdmin, (req, res) => {
    const users = loadJSON(USERS_FILE);
    const sanitized = users.map(u => sanitizeUser(u));
    res.json({ success: true, users: sanitized });
});

app.post('/api/admin/user/xp', verifyAdmin, (req, res) => {
    const { userId, xp } = req.body;
    if (!userId || xp === undefined) return res.status(400).json({ error: 'Укажите ID пользователя и значение XP' });

    const users = loadJSON(USERS_FILE);
    const uIdx = users.findIndex(u => u.id === userId || u.profileKey === userId);

    if (uIdx !== -1) {
        users[uIdx].xp = Number(xp);
        users[uIdx].weeklyXP = Number(xp);
        saveJSON(USERS_FILE, users);
        return res.json({ success: true, user: sanitizeUser(users[uIdx]) });
    }

    return res.status(404).json({ error: 'Пользователь не найден' });
});

app.delete('/api/admin/user/delete', verifyAdmin, (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Укажите ID пользователя' });

    let users = loadJSON(USERS_FILE);
    const initialLen = users.length;
    users = users.filter(u => u.id !== userId && u.profileKey !== userId);

    if (users.length < initialLen) {
        saveJSON(USERS_FILE, users);
        return res.json({ success: true, message: 'Пользователь удален' });
    }

    return res.status(404).json({ error: 'Пользователь не найден' });
});

app.delete('/api/admin/chat/delete-message', verifyAdmin, (req, res) => {
    const { messageId } = req.body;
    if (!messageId) return res.status(400).json({ error: 'Укажите ID сообщения' });

    let chat = loadJSON(CHAT_FILE);
    const initialLen = chat.length;
    chat = chat.filter(m => m.id !== messageId && m._id !== messageId);

    if (chat.length < initialLen) {
        saveJSON(CHAT_FILE, chat);
        io.emit('delete_message', { messageId });
        return res.json({ success: true, message: 'Сообщение удалено' });
    }

    return res.status(404).json({ error: 'Сообщение не найдено' });
});

// Еженедельный сброс Лиги (воскресенье 22:00 по времени Италии Europe/Rome)
function checkWeeklyLeagueReset() {
    try {
        const leagueState = loadJSON(LEAGUE_FILE);
        const now = new Date();
        const nowItaly = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Rome" }));

        const isSunday = nowItaly.getDay() === 0;
        const isPast22 = nowItaly.getHours() >= 22;

        const currentWeekTag = `${nowItaly.getFullYear()}-W${Math.ceil((nowItaly.getDate() + nowItaly.getDay()) / 7)}`;

        if (isSunday && isPast22 && leagueState.lastResetWeek !== currentWeekTag) {
            const users = loadJSON(USERS_FILE);
            
            // Сортируем лидеров недели
            const sorted = [...users].sort((a, b) => (b.weeklyXP || 0) - (a.weeklyXP || 0));

            // Награждение 1, 2 и 3 мест
            if (sorted[0]) sorted[0].xp = (sorted[0].xp || 0) + 100;
            if (sorted[1]) sorted[1].xp = (sorted[1].xp || 0) + 60;
            if (sorted[2]) sorted[2].xp = (sorted[2].xp || 0) + 30;

            // Сброс еженедельного прогресса XP для всех
            users.forEach(u => { u.weeklyXP = 0; });

            saveJSON(USERS_FILE, users);
            leagueState.lastResetWeek = currentWeekTag;
            leagueState.lastResetDate = nowItaly.toISOString();
            saveJSON(LEAGUE_FILE, leagueState);

            console.log('[League] Итоги еженедельной Лиги подведены! Награды зачислены.');
        }
    } catch (e) {
        console.error('[League Error]', e);
    }
}

// Проверяем сброс каждые 5 минут
setInterval(checkWeeklyLeagueReset, 5 * 60 * 1000);

// Чат Socket.io
io.on('connection', (socket) => {
    const chatHistory = loadJSON(CHAT_FILE);
    socket.emit('chat_history', chatHistory);

    socket.on('send_message', (data) => {
        const { username, avatar, text, userId, role } = data;
        if (!text || typeof text !== 'string') return;

        const cleanText = text.trim().slice(0, 150);
        if (!cleanText) return;

        const messageObj = {
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            userId: userId || 'anon',
            username: username || 'Гость',
            role: role || 'user',
            avatar: avatar || 'assets/icon.png',
            text: cleanText,
            timestamp: new Date().toISOString()
        };

        const currentHistory = loadJSON(CHAT_FILE);
        currentHistory.push(messageObj);

        if (currentHistory.length > 500) {
            currentHistory.splice(0, currentHistory.length - 500);
        }

        saveJSON(CHAT_FILE, currentHistory);
        io.emit('chat_message', messageObj);
    });

    socket.on('delete_message', (data) => {
        const messageId = typeof data === 'object' ? (data.messageId || data.id) : data;
        if (!messageId) return;

        let chat = loadJSON(CHAT_FILE);
        chat = chat.filter(m => m.id !== messageId && m._id !== messageId);
        saveJSON(CHAT_FILE, chat);

        io.emit('delete_message', { messageId });
    });
});

server.listen(APP_PORT, '0.0.0.0', () => {
    console.log(`[FoxyQuiz Server] Сервер запущен на порту ${APP_PORT}`);
    checkWeeklyLeagueReset();
});