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

    if (botToken && chatId) {
      // Функция экранирования специальных символов для HTML режима Telegram
      const escapeHtml = (str) => {
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      };

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

      if (!tgRes.ok) {
        const errorText = await tgRes.text();
        console.error('Ошибка отправки в Telegram Bot API:', errorText);
        return new Response(JSON.stringify({ 
          error: true, 
          message: 'Ошибка доставки сообщения ботом в Telegram. Проверьте правильность токена и ID чата.' 
        }), {
          status: 502,
          headers: corsHeaders
        });
      }
    } else {
      // Если переменные еще не заданы в панели Cloudflare, логируем в консоль Cloudflare
      console.warn(`[Внимание]: Переменные TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не настроены в Cloudflare Pages.`);
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

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
