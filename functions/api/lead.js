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

    if (botToken && chatId) {
      const textMessage = `🔔 *Новая заявка с сайта Татьяны Скорик!*\n\n` +
        `👤 *Имя:* ${cleanName}\n` +
        `✈️ *Контакт (Telegram / Телефон):* ${cleanContact}\n` +
        `⏱ *Время:* ${dateStr} (МСК)\n` +
        `🌐 *Формат:* Личный разбор / круизный клуб`;

      const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const tgRes = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: textMessage,
          parse_mode: 'Markdown'
        })
      });

      if (!tgRes.ok) {
        console.error('Ошибка отправки в Telegram Bot API:', await tgRes.text());
      }
    } else {
      // Если переменные еще не заданы в панели Cloudflare, логируем в консоль Cloudflare
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
