/**
 * Cloudflare Worker / Pages Advanced Mode Script (v1.2.1)
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
    return 'Не просмотрено';
  }

  if (videoStats.completed) {
    return 'Просмотрено полностью (100%) ✅';
  }

  const watched = videoStats.watchedSeconds;
  const duration = videoStats.durationSeconds;

  if (duration && duration > 0) {
    const percent = Math.min(100, Math.round((watched / duration) * 100));
    if (percent >= 92) {
      return 'Просмотрено полностью (100%) ✅';
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

// Форматирование даты в московском часовом поясе: DD.MM.YYYY HH:mm (под формат CRM)
function formatMoscowDate(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date);

    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return `${map.day}.${map.month}.${map.year} ${map.hour}:${map.minute}`;
  } catch (e) {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

// Форматирование размещения рекламы под колонку «Источник, место размещения»
function formatPlacement(urlParams) {
  if (!urlParams || typeof urlParams !== 'object') return 'Сайт (прямой заход)';
  if (urlParams.placement && typeof urlParams.placement === 'string') {
    return urlParams.placement;
  }
  const source = (urlParams.utm_source || '').toLowerCase().trim();
  const medium = (urlParams.utm_medium || '').trim();

  let platform = '';
  if (source === 'ig' || source.includes('instagram')) {
    platform = 'Instagram';
  } else if (source === 'fb' || source.includes('facebook')) {
    platform = 'Facebook';
  } else if (source === 'an' || source.includes('audience')) {
    platform = 'Audience Network';
  } else if (source) {
    platform = source;
  }

  let pos = medium;
  const mediumLower = medium.toLowerCase();
  if (mediumLower === 'reels' || mediumLower.includes('reels')) {
    pos = 'Reels';
  } else if (mediumLower.includes('mobile_feed')) {
    pos = 'Mobile_Feed';
  } else if (mediumLower.includes('feed')) {
    pos = 'Feed';
  } else if (mediumLower.includes('stories') || mediumLower.includes('story')) {
    pos = 'Stories';
  }

  if (platform && pos) {
    return `${platform}, ${pos}`;
  }
  return platform || pos || 'Сайт (прямой заход)';
}

// Отправка вебхука в n8n (поддерживает тестовый режим и боевой URL)
async function sendN8nWebhook(env, payload, isTest = false) {
  const defaultTestUrl = 'https://automations.inetskills.ru/webhook-test/landing-events';
  let targetUrl = defaultTestUrl;

  if (isTest) {
    targetUrl = defaultTestUrl;
  } else if (env.N8N_WEBHOOK_URL && env.N8N_WEBHOOK_URL.trim().length > 0) {
    targetUrl = env.N8N_WEBHOOK_URL.trim();
  }

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TanyaSkoryk-Landing/1.3'
      },
      body: JSON.stringify(payload)
    });

    const resJson = await res.json().catch(() => ({}));
    console.log(`n8n webhook (${isTest ? 'TEST' : 'PROD'} -> ${targetUrl}) status:`, res.status);
    return {
      status: res.ok ? 'success' : 'http_error',
      statusCode: res.status,
      target: targetUrl,
      isTest: isTest,
      response: resJson
    };
  } catch (err) {
    console.error('Ошибка отправки в n8n:', err);
    return {
      status: 'exception',
      target: targetUrl,
      isTest: isTest,
      error: err.message
    };
  }
}

const sendMetaCapiLeadEvent = sendMetaCapiEvent;

// Диагностический GET-обработчик (/api/lead или /api/config)
async function handleDiagnostics(env) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const telegramLink = env.TELEGRAM_LINK || 'https://t.me/SergeiVmeste';
  const whatsappLink = env.WHATSAPP_LINK || 'https://wa.me/37256256388';
  const fbAccessToken = env.FB_ACCESS_TOKEN;
  const fbPixelId = env.FB_PIXEL_ID || '4047095728920722';
  const n8nWebhookConfigured = Boolean(env.N8N_WEBHOOK_URL && env.N8N_WEBHOOK_URL.trim().length > 0);

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

  const isConfigured = Boolean(botToken && chatId && botStatus === 'valid') || n8nWebhookConfigured;

  return new Response(JSON.stringify({
    ok: true,
    status: isConfigured ? 'ready' : 'configuration_needed',
    telegramLink: telegramLink,
    whatsappLink: whatsappLink,
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
      capiStatus: Boolean(fbAccessToken) ? 'ready' : 'token_needed',
      n8n: {
        configured: n8nWebhookConfigured,
        activeWebhook: n8nWebhookConfigured ? env.N8N_WEBHOOK_URL.trim() : 'https://automations.inetskills.ru/webhook-test/landing-events (по умолчанию тестовый)',
        testWebhook: 'https://automations.inetskills.ru/webhook-test/landing-events'
      }
    },
    hints: [
      !n8nWebhookConfigured ? 'Для боевого режима добавьте N8N_WEBHOOK_URL в Cloudflare Settings -> Variables' : null,
      !botToken ? 'Telegram бот не настроен (если отправка идет через n8n, это нормально)' : null,
      'После добавления или изменения переменных в Cloudflare ОБЯЗАТЕЛЬНО сделайте Redeploy!'
    ].filter(Boolean)
  }, null, 2), {
    status: 200,
    headers: CORS_HEADERS
  });
}

// Обработчик отправки заявки и кликов
async function handleLead(request, env) {
  try {
    const data = await request.json();
    const isContactClick = data.type === 'contact' || data.action === 'telegram_click' || data.action === 'whatsapp_click';
    const isWhatsApp = data.messenger === 'whatsapp' || data.action === 'whatsapp_click';
    const messengerLabel = isWhatsApp ? 'WhatsApp' : 'Telegram';
    const { name, contact, consent } = data;

    // Валидация входных данных для формы заявки (для клика по мессенджерам валидация не требуется)
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
    let cleanContact = (contact && typeof contact === 'string') ? contact.trim() : '';
    // Очищаем контакт от возможных старых суффиксов в скобках, чтобы оставался только чистый контакт
    cleanContact = cleanContact.replace(/\s*\((?:telegram|whatsapp)\)\s*$/i, '').trim();

    // Извлекаем pathname страницы (например: "/travel", "/club" или "/")
    let pagePath = '/';
    try {
      if (data.pageUrl) {
        const parsedUrl = new URL(data.pageUrl);
        pagePath = parsedUrl.pathname || '/';
      }
    } catch (e) {
      pagePath = '/';
    }

    const dateFormatted = formatMoscowDate();
    const dateStr = dateFormatted + ' (МСК)';

    const botToken = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    const topicId = env.TELEGRAM_TOPIC_ID;

    // Извлечение IP клиента и User-Agent из заголовков запроса Cloudflare
    const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || '';
    const userAgent = request.headers.get('user-agent') || data.userAgent || '';
    const clientCountry = request.headers.get('CF-IPCountry') || '';
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
    const contentName = isContactClick 
      ? (isWhatsApp ? 'Кнопка WhatsApp (Главная)' : 'Кнопка Telegram (Главная)') 
      : 'Форма презентации';
    const eventPrefix = isContactClick ? (isWhatsApp ? 'contact_wa_' : 'contact_tg_') : 'lead_';
    const eventId = data.eventId || (eventPrefix + Date.now() + '_' + Math.random().toString(36).substring(2, 8));
    const visitorId = data.visitorId || ('vid_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8));

    // Проверяем тестовый режим (по параметрам URL test=1 / test_n8n=1 или флагу testMode)
    const isTestMode = Boolean(
      data.testMode ||
      (data.urlParams && (data.urlParams.test_n8n || data.urlParams.test || data.urlParams.test_event_code)) ||
      env.N8N_USE_TEST === 'true'
    );

    // 1. Отправка в Meta Conversions API (CAPI)
    const capiPromise = sendMetaCapiEvent(env, {
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

    // 2. Подготовка полей под таблицу CRM и отправка в n8n
    const videoProgressText = formatVideoProgress(data.videoStats);
    const placementFormatted = formatPlacement(data.urlParams);
    const adId = (data.urlParams && data.urlParams.ad_id) ? String(data.urlParams.ad_id).trim() : '';
    const campaignVal = (data.urlParams && (data.urlParams.campaign_id || data.urlParams.utm_campaign)) 
      ? String(data.urlParams.campaign_id || data.urlParams.utm_campaign).trim() 
      : '';

    // Источник сайта: Форма на сайте (Telegram) /travel или Форма на сайте (WhatsApp) /
    const siteSource = isContactClick
      ? `Клик (${messengerLabel}) ${pagePath}`
      : `Форма на сайте (${messengerLabel}) ${pagePath}`;

    const hasPriorLead = Boolean(data.hasPriorLead || (isContactClick && (cleanName || cleanContact)));
    const hasContacts = Boolean(cleanName || cleanContact);

    // Нормализуем телефон для хранения в CRM и последующей отправки в Meta CAPI из n8n
    const normalizedPhone = extractAndNormalizePhone(cleanContact);

    // Формируем чистый плоский (flat) объект без дубликатов
    const n8nPayload = {
      // 1. Идентификаторы и тип события
      event_type: isContactClick ? (isWhatsApp ? 'click_whatsapp' : 'click_telegram') : 'lead',
      event_name: eventName,
      event_id: eventId,
      visitor_id: visitorId,
      date: dateFormatted,

      // 2. Контактные данные
      // Имя и чистый контакт (без приписок в скобках)
      name: cleanName,
      contact: cleanContact,
      messenger: messengerLabel,
      has_contacts: hasContacts,
      has_prior_lead: hasPriorLead,

      // 3. Статусы и поля для Google Таблицы CRM (A - Q)
      status: (isContactClick && !cleanName) ? 'Клик в мессенджер' : 'Новый',
      lead_quality: 'Не определен',
      first_touch: dateFormatted,
      next_action: isContactClick ? 'Проверить диалог в мессенджере' : 'Связаться с клиентом',
      next_action_date: '',
      comment: '', // Оставляем чистым для заполнения менеджером вручную
      rejection_reason: '',
      interest: '',
      ad_id: adId,
      placement: placementFormatted,
      campaign: campaignVal,
      video: videoProgressText,
      site_source: siteSource,

      // 4. UTM-метки (плоские, уникальные)
      utm_source: (data.urlParams && data.urlParams.utm_source) || '',
      utm_medium: (data.urlParams && data.urlParams.utm_medium) || '',
      utm_campaign: (data.urlParams && data.urlParams.utm_campaign) || '',
      utm_content: (data.urlParams && data.urlParams.utm_content) || '',
      utm_term: (data.urlParams && data.urlParams.utm_term) || '',
      fbclid: data.fbclid || (data.urlParams && data.urlParams.fbclid) || '',

      // 5. Технические параметры
      page_url: data.pageUrl || 'https://tanyaskoryk.com',
      client_ip: clientIp,
      country: clientCountry,
      user_agent: userAgent,
      is_test: isTestMode,

      // 6. Данные для Meta CAPI из CRM (CompleteRegistration / Purchase из n8n)
      // Сохраняются в Google Sheets и используются при смене статуса лида
      fbc: finalFbc || '',
      fbp: finalFbp || '',
      phone_normalized: normalizedPhone || '',
      capi_lead_event_id: eventId
    };

    // Запускаем отправку в n8n (только для лидов с формы; клики по кнопкам мессенджеров на landing-events не отправляются)
    const n8nPromise = isContactClick
      ? Promise.resolve({ status: 'skipped', reason: 'contact_click_disabled' })
      : sendN8nWebhook(env, n8nPayload, isTestMode);

    // Дожидаемся результатов n8n и CAPI
    const [capiResult, n8nResult] = await Promise.all([capiPromise, n8nPromise]);

    // 3. Прямая отправка в Telegram с сайта полностью отключена (все уведомления идут через n8n)
    const allowDirectTelegram = false;

    if (allowDirectTelegram) {
      try {
        const utmLines = [];
        if (data.urlParams && typeof data.urlParams === 'object') {
          const allowedKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
          const labelMap = {
            utm_source: 'Источник',
            utm_medium: 'Тип трафика',
            utm_campaign: 'Кампания',
            utm_content: 'Объявление'
          };

          for (const k of allowedKeys) {
            const val = data.urlParams[k];
            if (val && typeof val === 'string' && val.trim().length > 0) {
              const label = labelMap[k] || k;
              utmLines.push(`• <b>${label}:</b> <code>${escapeHtml(val.trim())}</code>`);
            }
          }
        }

        let capiLine = null;
        if (env.FB_ACCESS_TOKEN && capiResult.status !== 'success') {
          capiLine = `🎯 <b>Meta CAPI:</b> ⚠️ Ошибка (${escapeHtml(capiResult.status)})`;
        }

        const videoLine = `🎬 <b>Просмотр видео:</b> ${escapeHtml(videoProgressText)}`;
        let messageParts = [];

        if (isContactClick) {
          const title = isWhatsApp
            ? `💬 <b>Переход в WhatsApp с сайта Татьяны Скорик!</b>`
            : `💬 <b>Переход в Telegram с сайта Татьяны Скорик!</b>`;
          const actionText = isWhatsApp
            ? `Клик по кнопке «Написать мне в WhatsApp»`
            : `Клик по кнопке «Написать мне в телеграм»`;

          messageParts = [
            title,
            ``
          ];

          if (cleanName) {
            messageParts.push(`👤 <b>Имя:</b> ${escapeHtml(cleanName)}`);
          }
          if (cleanContact) {
            messageParts.push(`📱 <b>Контакт:</b> ${escapeHtml(cleanContact)}`);
          }
          if (hasPriorLead) {
            messageParts.push(`ℹ️ <i>Пользователь ранее оставил заявку на сайте</i>`, ``);
          }

          messageParts.push(
            `⏱ <b>Время перехода:</b> ${dateStr}`,
            videoLine
          );

          if (utmLines.length > 0) {
            messageParts.push(``, `📊 <b>UTM-метки:</b>`, ...utmLines);
          }

          if (capiLine) {
            messageParts.push(``, capiLine);
          }

          messageParts.push(``, `🌐 <b>Действие:</b> ${actionText}`);
        } else {
          const safeName = escapeHtml(cleanName);
          const safeContact = escapeHtml(cleanContact);
          messageParts = [
            `🔔 <b>Новая заявка с сайта Татьяны Скорик!</b>`,
            ``,
            `👤 <b>Имя:</b> ${safeName}`,
            `✈️ <b>Telegram / Телефон:</b> ${safeContact}`,
            `⏱ <b>Время отправки:</b> ${dateStr}`,
            videoLine
          ];

          if (utmLines.length > 0) {
            messageParts.push(``, `📊 <b>UTM-метки:</b>`, ...utmLines);
          }

          if (capiLine) {
            messageParts.push(``, capiLine);
          }
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
        await fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tgPayload)
        });
      } catch (tgErr) {
        console.warn('Direct Telegram notification failed (n8n is primary):', tgErr.message);
      }
    }

    // Успешный ответ клиенту
    return new Response(JSON.stringify({
      success: true,
      message: isContactClick ? 'Переход зафиксирован' : 'Спасибо! Ваша заявка принята. В ближайшее время я или мой координатор свяжемся с вами, чтобы обсудить детали.',
      visitorId: visitorId,
      n8n: {
        status: n8nResult.status,
        statusCode: n8nResult.statusCode,
        isTest: n8nResult.isTest
      },
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
      if (url.pathname === '/travel' || url.pathname === '/travel/' || url.pathname === '/travel.html') {
        const travelUrl = new URL(request.url);
        travelUrl.pathname = '/travel.html';
        return env.ASSETS.fetch(new Request(travelUrl.toString(), request));
      }
      if (url.pathname === '/club' || url.pathname === '/club/' || url.pathname === '/club.html') {
        const clubUrl = new URL(request.url);
        clubUrl.pathname = '/travel.html';
        return env.ASSETS.fetch(new Request(clubUrl.toString(), request));
      }
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
