/**
 * Cloudflare Worker / Pages Advanced Mode Script
 * Обеспечивает работу API /api/lead, отправку в Telegram, передачу событий в Meta Conversions API (CAPI)
 * и отдачу статических файлов лендинга
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

// Функция вычисления SHA-256 (шестнадцатеричный формат, нижний регистр) для Meta CAPI
async function sha256(str) {
  if (!str) return null;
  const clean = String(str).trim().toLowerCase();
  if (!clean) return null;
  const msgBuffer = new TextEncoder().encode(clean);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Нормализация телефонного номера для Meta CAPI (только цифры в международном формате)
function extractAndNormalizePhone(str) {
  if (!str) return null;
  const digits = String(str).replace(/\D/g, '');
  if (digits.length < 9) return null;
  // Если номер из 11 цифр начинается с 8: переводим в 7
  if (digits.length === 11 && digits.startsWith('8')) {
    return '7' + digits.slice(1);
  }
  return digits;
}

// Извлечение email из строки контакта (если пользователь указал e-mail)
function extractEmail(str) {
  if (!str) return null;
  const match = String(str).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0].toLowerCase().trim() : null;
}

// Форматирование статистики просмотра видео для Telegram
function formatVideoProgress(videoStats) {
  if (!videoStats || !videoStats.started || !videoStats.watchedSeconds || videoStats.watchedSeconds < 2) {
    return 'Не запускал';
  }

  if (videoStats.completed) {
    return 'Досмотрел до конца (100%) ✅';
  }

  const watched = videoStats.watchedSeconds;
  const duration = videoStats.durationSeconds;

  if (duration && duration > 0) {
    const percent = Math.min(100, Math.round((watched / duration) * 100));
    if (percent >= 92) {
      return 'Досмотрел до конца (100%) ✅';
    }

    const watchedM = Math.floor(watched / 60);
    const watchedS = watched % 60;
    const durM = Math.floor(duration / 60);
    const durS = duration % 60;

    const watchedStr = `${watchedM} мин ${watchedS < 10 ? '0' : ''}${watchedS} сек`;
    const durStr = `${durM}:${durS < 10 ? '0' : ''}${durS}`;

    return `${watchedStr} из ${durStr} (${percent}%)`;
  }

  const watchedM = Math.floor(watched / 60);
  const watchedS = watched % 60;
  return `${watchedM} мин ${watchedS < 10 ? '0' : ''}${watchedS} сек`;
}

// Отправка события конверсии в Meta Conversions API (Graph API)
async function sendMetaCapiEvent(env, {
  eventName = 'Lead',
  contentName = 'Форма презентации',
  eventId,
  name,
  contact,
  pageUrl,
  clientIp,
  userAgent,
  fbp,
  fbc,
  fbclid,
  urlParams,
  videoStats
}) {
  const pixelId = env.FB_PIXEL_ID || '4047095728920722';
  const accessToken = env.FB_ACCESS_TOKEN;
  const testEventCode = env.FB_TEST_EVENT_CODE || (urlParams && urlParams.test_event_code);

  // Хэширование персональных данных (SHA-256) в соответствии со стандартом Meta
  const nameParts = (name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null;

  const normalizedPhone = extractAndNormalizePhone(contact);
  const extractedEmail = extractEmail(contact);

  const hashedFn = firstName ? await sha256(firstName) : null;
  const hashedLn = lastName ? await sha256(lastName) : null;
  const hashedPhone = normalizedPhone ? await sha256(normalizedPhone) : null;
  const hashedEmail = extractedEmail ? await sha256(extractedEmail) : null;

  let finalFbc = fbc;
  if (!finalFbc && fbclid) {
    finalFbc = `fb.1.${Date.now()}.${fbclid}`;
  }

  const userData = {};
  if (clientIp) userData.client_ip_address = clientIp;
  if (userAgent) userData.client_user_agent = userAgent;
  if (fbp) userData.fbp = fbp;
  if (finalFbc) userData.fbc = finalFbc;
  if (hashedFn) userData.fn = [hashedFn];
  if (hashedLn) userData.ln = [hashedLn];
  if (hashedPhone) userData.ph = [hashedPhone];
  if (hashedEmail) userData.em = [hashedEmail];

  // Передача всех параметров ссылки (UTM, ad_id, fbclid и т.д.) в custom_data
  const customData = {
    content_name: contentName,
    content_category: 'Круизный клуб / Бизнес',
    status: eventName === 'Lead' ? 'submitted' : 'clicked'
  };

  if (eventName === 'Lead') {
    customData.currency = 'USD';
    customData.value = 0;
  }

  if (urlParams && typeof urlParams === 'object') {
    for (const [k, v] of Object.entries(urlParams)) {
      if (typeof v === 'string' && v.length > 0 && v.length < 300) {
        customData[k] = v;
      }
    }
  }

  if (videoStats && videoStats.watchedSeconds) {
    customData.video_watched_seconds = videoStats.watchedSeconds;
    if (videoStats.durationSeconds) {
      customData.video_watched_percent = Math.min(100, Math.round((videoStats.watchedSeconds / videoStats.durationSeconds) * 100));
    }
  }

  const eventPayload = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    event_source_url: pageUrl || 'https://tanyaskoryk.com',
    action_source: 'website',
    user_data: userData,
    custom_data: customData
  };

  const capiBody = {
    data: [eventPayload]
  };

  if (testEventCode) {
    capiBody.test_event_code = String(testEventCode).trim();
  }

  if (!accessToken) {
    console.warn('Meta CAPI: переменная FB_ACCESS_TOKEN не настроена в Cloudflare.');
    return {
      status: 'no_token',
      message: 'FB_ACCESS_TOKEN не задан'
    };
  }

  try {
    const apiUrl = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${encodeURIComponent(accessToken.trim())}`;
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(capiBody)
    });

    const resJson = await res.json().catch(() => ({}));
    if (res.ok && resJson.events_received) {
      console.log('Meta CAPI Lead Event successfully delivered:', resJson);
      return {
        status: 'success',
        eventsReceived: resJson.events_received,
        fbtrace_id: resJson.fbtrace_id
      };
    } else {
      console.error('Meta CAPI error response:', resJson);
      return {
        status: 'api_error',
        error: resJson.error || resJson
      };
    }
  } catch (err) {
    console.error('Meta CAPI network/fetch exception:', err);
    return {
      status: 'exception',
      error: err.message
    };
  }
}

const sendMetaCapiLeadEvent = sendMetaCapiEvent;

// Диагностический GET-обработчик (/api/lead или /api/config)
async function handleDiagnostics(env) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const telegramLink = env.TELEGRAM_LINK || 'https://t.me/m/cThxNnSsYTE6';
  const fbAccessToken = env.FB_ACCESS_TOKEN;
  const fbPixelId = env.FB_PIXEL_ID || '4047095728920722';

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
      errorDetail: errorDetail,
      fbPixelId: fbPixelId,
      hasFbAccessToken: Boolean(fbAccessToken),
      hasFbTestEventCode: Boolean(env.FB_TEST_EVENT_CODE),
      capiStatus: Boolean(fbAccessToken) ? 'ready' : 'token_needed'
    },
    hints: [
      !botToken ? 'Добавьте TELEGRAM_BOT_TOKEN в Cloudflare Settings -> Variables' : null,
      !chatId ? 'Добавьте TELEGRAM_CHAT_ID в Cloudflare Settings -> Variables' : null,
      !fbAccessToken ? 'Для Meta Conversions API (CAPI) добавьте FB_ACCESS_TOKEN в Cloudflare Settings -> Variables' : null,
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
    const isContactClick = data.type === 'contact' || data.action === 'telegram_click';
    const { name, contact, consent } = data;

    // Валидация входных данных для формы заявки (для клика по Telegram валидация не требуется)
    if (!isContactClick) {
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
    }

    const cleanName = (name && typeof name === 'string') ? name.trim() : '';
    const cleanContact = (contact && typeof contact === 'string') ? contact.trim() : '';
    const dateStr = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

    const botToken = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    const topicId = env.TELEGRAM_TOPIC_ID;

    // Извлечение IP клиента и User-Agent из заголовков запроса Cloudflare
    const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || '';
    const userAgent = request.headers.get('user-agent') || data.userAgent || '';
    const cookieHeader = request.headers.get('cookie') || '';

    let finalFbp = data.fbp;
    if (!finalFbp && cookieHeader) {
      const match = cookieHeader.match(/_fbp=([^;]+)/);
      if (match) finalFbp = match[1];
    }

    let finalFbc = data.fbc;
    if (!finalFbc && cookieHeader) {
      const match = cookieHeader.match(/_fbc=([^;]+)/);
      if (match) finalFbc = match[1];
    }

    const eventName = isContactClick ? 'Contact' : 'Lead';
    const contentName = isContactClick ? 'Кнопка Telegram (Главная)' : 'Форма презентации';
    const eventPrefix = isContactClick ? 'contact_' : 'lead_';
    const eventId = data.eventId || (eventPrefix + Date.now() + '_' + Math.random().toString(36).substring(2, 8));

    // Параллельная или последовательная отправка в Meta Conversions API
    const capiResult = await sendMetaCapiEvent(env, {
      eventName: eventName,
      contentName: contentName,
      eventId: eventId,
      name: cleanName,
      contact: cleanContact,
      pageUrl: data.pageUrl,
      clientIp: clientIp,
      userAgent: userAgent,
      fbp: finalFbp,
      fbc: finalFbc,
      fbclid: data.fbclid,
      urlParams: data.urlParams,
      videoStats: data.videoStats
    });

    if (!botToken || !chatId) {
      const missingVars = [];
      if (!botToken) missingVars.push('TELEGRAM_BOT_TOKEN');
      if (!chatId) missingVars.push('TELEGRAM_CHAT_ID');

      const warningMsg = `В Cloudflare не обнаружены переменные: ${missingVars.join(', ')}. Убедитесь, что переменные добавлены в Settings -> Variables и выполнен повторный деплой (Redeploy).`;
      console.warn(warningMsg);

      return new Response(JSON.stringify({
        error: true,
        message: warningMsg,
        capi: capiResult
      }), {
        status: 503,
        headers: CORS_HEADERS
      });
    }

    // Сбор UTM-меток и параметров рекламных кампаний
    const utmLines = [];
    if (data.urlParams && typeof data.urlParams === 'object') {
      // Приоритетный порядок стандартных меток
      const priorityKeys = [
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_content',
        'utm_term',
        'fbclid',
        'ad_id',
        'adset_id',
        'campaign_id'
      ];

      const addedKeys = new Set();

      for (const k of priorityKeys) {
        const val = data.urlParams[k];
        if (val && typeof val === 'string' && val.trim().length > 0) {
          utmLines.push(`• <b>${escapeHtml(k)}:</b> <code>${escapeHtml(val.trim())}</code>`);
          addedKeys.add(k);
        }
      }

      // Добавляем любые другие метки, начинающиеся на utm_
      for (const [k, v] of Object.entries(data.urlParams)) {
        if (!addedKeys.has(k) && k.toLowerCase().startsWith('utm_')) {
          if (v && typeof v === 'string' && v.trim().length > 0) {
            utmLines.push(`• <b>${escapeHtml(k)}:</b> <code>${escapeHtml(v.trim())}</code>`);
            addedKeys.add(k);
          }
        }
      }
    }

    // Статус Meta Conversions API (добавляется только если настроен токен)
    let capiLine = null;
    if (env.FB_ACCESS_TOKEN) {
      if (capiResult.status === 'success') {
        capiLine = isContactClick
          ? `🎯 <b>Meta CAPI:</b> ✅ Зафиксирован переход (Contact)`
          : `🎯 <b>Meta CAPI:</b> ✅ Зафиксирован лид (Lead)`;
      } else {
        capiLine = `🎯 <b>Meta CAPI:</b> ⚠️ Ошибка (${escapeHtml(capiResult.status)})`;
      }
    }

    const videoProgressText = formatVideoProgress(data.videoStats);
    const videoLine = `🎬 <b>Просмотр видео:</b> ${escapeHtml(videoProgressText)}`;

    let messageParts = [];

    if (isContactClick) {
      messageParts = [
        `💬 <b>Переход в Telegram с сайта Татьяны Скорик!</b>`,
        ``,
        `⏱ <b>Время перехода:</b> ${dateStr} (МСК)`,
        videoLine
      ];
    } else {
      const safeName = escapeHtml(cleanName);
      const safeContact = escapeHtml(cleanContact);
      messageParts = [
        `🔔 <b>Новая заявка с сайта Татьяны Скорик!</b>`,
        ``,
        `👤 <b>Имя:</b> ${safeName}`,
        `✈️ <b>Telegram / Телефон:</b> ${safeContact}`,
        `⏱ <b>Время отправки:</b> ${dateStr} (МСК)`,
        videoLine
      ];
    }

    // Добавляем блок UTM-меток ТОЛЬКО если есть хотя бы одна метка
    if (utmLines.length > 0) {
      messageParts.push(``, `📊 <b>UTM-метки:</b>`, ...utmLines);
    }

    // Добавляем статус Meta CAPI (если токен настроен)
    if (capiLine) {
      messageParts.push(``, capiLine);
    }

    if (isContactClick) {
      messageParts.push(``, `🌐 <b>Действие:</b> Клик по кнопке «Написать мне в телеграм»`);
    } else {
      messageParts.push(``, `🌐 <b>Источник:</b> Форма презентации (Cloudflare Worker)`);
    }

    const htmlMessage = messageParts.join('\n');

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
        message: `Ошибка Telegram (${tgData.error_code || 500}): ${errorHelp}`,
        capi: capiResult
      }), {
        status: 502,
        headers: CORS_HEADERS
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: isContactClick ? 'Переход зафиксирован' : 'Спасибо! Ваша заявка принята. В ближайшее время я свяжусь с вами.',
      capi: {
        status: capiResult.status
      }
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
