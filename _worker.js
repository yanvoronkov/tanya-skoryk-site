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

// Обработчик отправки заявки
async function handleLead(request, env) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8'
  };

  try {
    const data = await request.json();
    const { name, contact, consent } = data;

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

    const botToken = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    const topicId = env.TELEGRAM_TOPIC_ID;

    if (botToken && chatId) {
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

      if (!tgRes.ok) {
        const errorText = await tgRes.text();
        console.error('Ошибка Telegram Bot API:', errorText);
        return new Response(JSON.stringify({
          error: true,
          message: 'Ошибка доставки сообщения ботом в Telegram. Проверьте правильность токена и ID чата.'
        }), {
          status: 502,
          headers: corsHeaders
        });
      }
    } else {
      console.warn('[Внимание]: Переменные TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не настроены.');
      console.log(`[Новая заявка]: Имя: ${cleanName}, Контакт: ${cleanContact}, Дата: ${dateStr}`);
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Спасибо! Ваша заявка принята. Татьяна свяжется с вами в ближайшее время.'
    }), {
      status: 200,
      headers: corsHeaders
    });

  } catch (err) {
    console.error('Ошибка обработки формы:', err);
    return new Response(JSON.stringify({
      error: true,
      message: 'Произошла ошибка при отправке заявки. Попробуйте написать в Telegram напрямую.'
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Роут API для приема заявок
    if (url.pathname === '/api/lead') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
          }
        });
      }

      if (request.method === 'POST') {
        return handleLead(request, env);
      }

      return new Response(JSON.stringify({ error: true, message: 'Method Not Allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Для всех остальных запросов отдаем статические файлы
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
