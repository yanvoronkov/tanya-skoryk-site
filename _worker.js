/**
 * Cloudflare Worker / Pages Advanced Mode Script
 * Обеспечивает работу API /api/lead и отдачу статических файлов
 */

// Функция экранирования HTML для безопасной отправки в Telegram
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

// Диагностический GET-обработчик (/api/lead или /api/config)
async function handleDiagnostics(env) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const telegramLink = env.TELEGRAM_LINK || null;

  let botStatus = 'not_configured';
  let botUsername = null;
  let botFirstName = null;
  let errorDetail = null;

  if (botToken) {
    try {
      const getMeRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const getMeData = await getMeRes.json();
      if (getMeData.ok) {
        botStatus = 'valid';
        botUsername = getMeData.result.username;
        botFirstName = getMeData.result.first_name;
      } else {
        botStatus = 'invalid_token';
        errorDetail = getMeData.description;
      }
    } catch (e) {
      botStatus = 'fetch_error';
      errorDetail = e.message;
    }
  }

  const isConfigured = Boolean(botToken && chatId && botStatus === 'valid');

  return new Response(JSON.stringify({
    ok: true,
    status: isConfigured ? 'ready' : 'configuration_needed',
    telegramLink: telegramLink,
    diagnostics: {
      hasBotToken: Boolean(botToken),
      hasChatId: Boolean(chatId),
      chatIdMasked: chatId ? String(chatId).slice(0, 3) + '***' + String(chatId).slice(-2) : null,
      botStatus: botStatus,
      botUsername: botUsername ? `@${botUsername}` : null,
      botFirstName: botFirstName,
      errorDetail: errorDetail
    },
    hints: [
      !botToken ? 'Добавьте TELEGRAM_BOT_TOKEN в Cloudflare Settings -> Variables' : null,
      !chatId ? 'Добавьте TELEGRAM_CHAT_ID в Cloudflare Settings -> Variables' : null,
      botUsername ? `Обязательно напишите /start боту @${botUsername}, чтобы он мог слать вам сообщения` : null,
      'После добавления или изменения переменных в Cloudflare ОБЯЗАТЕЛЬНО сделайте Redeploy!'
    ].filter(Boolean)
  }, null, 2), {
    status: 200,
    headers: CORS_HEADERS
  });
}

// Обработчик отправки заявки
async function handleLead(request, env) {
  try {
    const data = await request.json();
    const { name, contact, consent } = data;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return new Response(JSON.stringify({ error: true, message: 'Пожалуйста, укажите ваше имя' }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    if (!contact || typeof contact !== 'string' || contact.trim().length === 0) {
      return new Response(JSON.stringify({ error: true, message: 'Пожалуйста, укажите ваш Telegram или телефон' }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    if (!consent) {
      return new Response(JSON.stringify({ error: true, message: 'Необходимо согласие на обработку персональных данных' }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    const cleanName = name.trim();
    const cleanContact = contact.trim();
    const dateStr = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

    const botToken = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    const topicId = env.TELEGRAM_TOPIC_ID;

    if (!botToken || !chatId) {
      const missingVars = [];
      if (!botToken) missingVars.push('TELEGRAM_BOT_TOKEN');
      if (!chatId) missingVars.push('TELEGRAM_CHAT_ID');

      const warningMsg = `В Cloudflare не обнаружены переменные: ${missingVars.join(', ')}. Убедитесь, что переменные добавлены в Settings -> Variables и выполнен повторный деплой (Redeploy).`;
      console.warn(warningMsg);

      return new Response(JSON.stringify({
        error: true,
        message: warningMsg
      }), {
        status: 503,
        headers: CORS_HEADERS
      });
    }

    const safeName = escapeHtml(cleanName);
    const safeContact = escapeHtml(cleanContact);

    const htmlMessage = [
      `🔔 <b>Новая заявка с сайта Татьяны Скорик!</b>`,
      ``,
      `👤 <b>Имя:</b> ${safeName}`,
      `✈️ <b>Telegram / Телефон:</b> ${safeContact}`,
      `⏱ <b>Время отправки:</b> ${dateStr} (МСК)`,
      `🌐 <b>Источник:</b> Форма презентации (Cloudflare)`
    ].join('\n');

    const tgPayload = {
      chat_id: chatId,
      text: htmlMessage,
      parse_mode: 'HTML'
    };

    if (topicId) {
      tgPayload.message_thread_id = Number(topicId);
    }

    const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const tgRes = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tgPayload)
    });

    const tgData = await tgRes.json().catch(() => ({}));

    if (!tgRes.ok || !tgData.ok) {
      let errorHelp = tgData.description || 'Неизвестная ошибка Telegram API';
      if (tgData.error_code === 403) {
        errorHelp += ' -> Вы не нажали /start в боте! Напишите боту в Telegram и нажмите кнопку Start.';
      } else if (tgData.error_code === 400 && tgData.description && tgData.description.includes('chat not found')) {
        errorHelp += ' -> Неверный TELEGRAM_CHAT_ID или бот не добавлен в этот чат.';
      } else if (tgData.error_code === 401) {
        errorHelp += ' -> Неверный токен TELEGRAM_BOT_TOKEN.';
      }

      console.error('Ошибка Telegram Bot API:', errorHelp);
      return new Response(JSON.stringify({
        error: true,
        message: `Ошибка Telegram (${tgData.error_code || 500}): ${errorHelp}`
      }), {
        status: 502,
        headers: CORS_HEADERS
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Спасибо! Ваша заявка принята. В ближайшее время я свяжусь с вами.'
    }), {
      status: 200,
      headers: CORS_HEADERS
    });

  } catch (err) {
    console.error('Ошибка обработки формы:', err);
    return new Response(JSON.stringify({
      error: true,
      message: 'Произошла внутренняя ошибка сервера при обработке заявки: ' + (err.message || '')
    }), {
      status: 500,
      headers: CORS_HEADERS
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Роут API для приема заявок и диагностики
    if (url.pathname === '/api/lead' || url.pathname === '/api/config') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS
        });
      }

      if (request.method === 'GET') {
        return handleDiagnostics(env);
      }

      if (request.method === 'POST') {
        return handleLead(request, env);
      }

      return new Response(JSON.stringify({ error: true, message: 'Method Not Allowed' }), {
        status: 405,
        headers: CORS_HEADERS
      });
    }

    // Для всех остальных запросов отдаем статические файлы
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
