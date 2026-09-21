/**
 * Cloudflare Pages Function: /api/lead
 * Прием заявок с формы лендинга и отправка в Telegram
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  // CORS заголовки
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8'
  };

  try {
    const data = await request.json();
    const { name, contact, consent } = data;

    // Валидация входных данных
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return new Response(JSON.stringify({ error: true, message: 'Пожалуйста, укажите ваше имя' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    if (!contact || typeof contact !== 'string' || contact.trim().length === 0) {
      return new Response(JSON.stringify({ error: true, message: 'Пожалуйста, укажите ваш Telegram или телефон' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    if (!consent) {
      return new Response(JSON.stringify({ error: true, message: 'Необходимо согласие на обработку персональных данных' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    const cleanName = name.trim();
    const cleanContact = contact.trim();
    const dateStr = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

    // Проверка настроек Telegram Bot в переменных окружения Cloudflare
    const botToken = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    const topicId = env.TELEGRAM_TOPIC_ID; // Опционально: ID темы/топика в супергруппе

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
        headers: corsHeaders
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
      `🌐 <b>Источник:</b> Форма презентации (Cloudflare Pages)`
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
        headers: corsHeaders
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Спасибо! Ваша заявка принята. В ближайшее время я свяжусь с вами.'
    }), {
      status: 200,
      headers: corsHeaders
    });

  } catch (err) {
    console.error('Ошибка обработки формы:', err);
    return new Response(JSON.stringify({
      error: true,
      message: 'Произошла внутренняя ошибка сервера при обработке заявки: ' + (err.message || '')
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

export async function onRequestGet(context) {
  const { env } = context;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const telegramLink = env.TELEGRAM_LINK || 'https://t.me/m/cThxNnSsYTE6';

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
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
