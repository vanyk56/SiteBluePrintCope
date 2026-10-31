// Generates a small multi-page marketing site used for the end-to-end test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');
const icon = {
  zap: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  shield: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  chart: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>',
  users: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>',
  globe: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20z"/></svg>',
  code: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  arrow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
  logo: '<svg width="32" height="32" viewBox="0 0 32 32" aria-label="Nimbus logo"><rect width="32" height="32" rx="8" fill="#6d28d9"/><path d="M9 21c0-3 2-5 5-5 1-3 3-4 5-4 3 0 5 2 5 5 2 0 3 1 3 3s-1 3-3 3H11c-1 0-2-1-2-2z" fill="#fff"/></svg>',
  x: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-label="X"><path d="M18.2 2H21l-6.5 7.4L22 22h-6l-4.7-6.1L5.8 22H3l7-8L2 2h6.1l4.3 5.6L18.2 2zm-1 18h1.6L7 3.9H5.3L17.2 20z"/></svg>',
  github: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-label="GitHub"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z"/></svg>',
};
const header = `
<div class="announcement">🎉 Nimbus 2.0 уже здесь — <a href="/blog/post-1">читать анонс</a></div>
<header class="site-header">
  <div class="container">
    <a href="/" class="logo">${icon.logo}<span>Nimbus</span></a>
    <nav class="nav" aria-label="Main">
      <a href="/#features">Возможности</a>
      <a href="/pricing">Тарифы</a>
      <div class="dropdown"><span>Ресурсы</span>
        <div class="dropdown-menu"><a href="/blog">Блог</a><a href="/about">О компании</a><a href="/docs">Документация</a></div>
      </div>
      <a href="/about">О нас</a>
    </nav>
    <div class="header-actions">
      <a href="/login" class="btn btn-ghost">Войти</a>
      <a href="/signup" class="btn btn-primary">Начать бесплатно ${icon.arrow}</a>
    </div>
    <button class="burger" aria-label="Открыть меню" aria-expanded="false" aria-controls="mobile-menu"><span></span><span></span><span></span></button>
  </div>
</header>
<div class="mobile-menu" id="mobile-menu"><a href="/#features">Возможности</a><a href="/pricing">Тарифы</a><a href="/blog">Блог</a><a href="/about">О нас</a><a href="/signup">Начать бесплатно</a></div>`;
const footer = `
<footer class="site-footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-col"><h4>Продукт</h4><a href="/#features">Возможности</a><a href="/pricing">Тарифы</a><a href="/changelog">Обновления</a></div>
      <div class="footer-col"><h4>Компания</h4><a href="/about">О нас</a><a href="/blog">Блог</a><a href="/careers">Вакансии</a></div>
      <div class="footer-col"><h4>Поддержка</h4><a href="/docs">Документация</a><a href="/contact">Контакты</a><a href="/private/admin">Статус</a></div>
      <div class="footer-col"><h4>Правовое</h4><a href="/privacy">Конфиденциальность</a><a href="/terms">Условия</a><a href="/cookies">Cookies</a></div>
    </div>
    <div class="footer-bottom">
      <span>© 2025 Nimbus Inc. Все права защищены.</span>
      <div class="socials"><a href="https://x.com/nimbus" target="_blank" aria-label="X">${icon.x}</a><a href="https://github.com/nimbus" target="_blank" aria-label="GitHub">${icon.github}</a></div>
    </div>
  </div>
</footer>
<div class="cookie-banner" id="cookie"><span>Мы используем cookies, чтобы сайт работал лучше.</span><button class="btn btn-primary" onclick="document.getElementById('cookie').classList.add('hidden')">Принять</button></div>
<script src="https://www.googletagmanager.com/gtag/js?id=G-TEST123" async></script>
<script>
document.querySelector('.burger').addEventListener('click', function () { var m = document.getElementById('mobile-menu'); var o = m.classList.toggle('open'); this.setAttribute('aria-expanded', o ? 'true' : 'false'); });
document.querySelectorAll('[role="tab"]').forEach(function (t) { t.addEventListener('click', function () {
  document.querySelectorAll('[role="tab"]').forEach(function (x) { x.setAttribute('aria-selected', 'false'); });
  document.querySelectorAll('[role="tabpanel"]').forEach(function (p) { p.hidden = true; });
  t.setAttribute('aria-selected', 'true'); document.getElementById(t.getAttribute('aria-controls')).hidden = false; }); });
</script>`;
const page = (title, desc, body) => `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="description" content="${desc}">
<meta property="og:title" content="${title}"><meta property="og:image" content="/img/og.png"><meta name="theme-color" content="#6d28d9">
<link rel="icon" href="/img/favicon.png" type="image/png"><link rel="stylesheet" href="/styles.css">
</head><body>${header}
<main>${body}</main>${footer}
</body></html>`;
const features = [
  ['zap', 'Мгновенный деплой', 'Публикуйте изменения за секунды — без очередей и ручных шагов.'],
  ['shield', 'Безопасность по умолчанию', 'SSO, аудит действий и шифрование данных на каждом уровне.'],
  ['chart', 'Аналитика в реальном времени', 'Следите за метриками продукта на живых дашбордах.'],
  ['users', 'Командная работа', 'Комментарии, роли и общие рабочие пространства для всей команды.'],
  ['globe', 'Глобальная CDN', '300+ точек присутствия: контент рядом с каждым пользователем.'],
  ['code', 'API и SDK', 'Полноценный REST API и SDK для TypeScript, Python и Go.'],
];
const plans = [
  ['Старт', '$0', 'Для личных проектов', ['1 проект', 'Базовая аналитика', 'Сообщество'], 'Начать', false],
  ['Команда', '$19', 'Для растущих команд', ['10 проектов', 'Продвинутая аналитика', 'Приоритетная поддержка', 'SSO'], 'Попробовать 14 дней', true],
  ['Бизнес', '$49', 'Для компаний', ['Безлимит проектов', 'Аудит и роли', 'SLA 99.99%', 'Персональный менеджер', 'On-premise'], 'Связаться с нами', false],
];
const pricingSection = (h) => `
<section class="section" id="pricing"><div class="container">
  <div class="section-head"><h2>${h}</h2><p>Начните бесплатно и переходите на платный тариф, когда будете готовы.</p></div>
  <div class="pricing-grid">${plans.map(([n, p, d, list, cta, f]) => `
    <div class="plan${f ? ' featured' : ''}">${f ? '<span class="badge">Популярный</span>' : ''}<h3>${n}</h3><div class="price">${p}<small>/мес</small></div><p>${d}</p>
      <ul>${list.map((x) => `<li>${icon.check}<span>${x}</span></li>`).join('')}</ul>
      <a href="/signup" class="btn ${f ? 'btn-primary' : 'btn-ghost'}">${cta}</a></div>`).join('')}
  </div></div></section>`;
const faq = `
<section class="section"><div class="container"><div class="section-head"><h2>Частые вопросы</h2></div><div class="faq">
  <details><summary>Можно ли сменить тариф позже?</summary><p>Да, тариф можно повысить или понизить в любой момент — разница пересчитывается пропорционально.</p></details>
  <details><summary>Есть ли бесплатный пробный период?</summary><p>Тариф «Команда» можно бесплатно попробовать 14 дней без привязки карты.</p></details>
  <details><summary>Где хранятся данные?</summary><p>В дата-центрах ЕС и США на ваш выбор, с ежедневными резервными копиями.</p></details>
  <details><summary>Как отменить подписку?</summary><p>В настройках аккаунта, в один клик. Никаких скрытых платежей.</p></details>
</div></div></section>`;
const home = `
<section class="hero"><div class="container hero-grid">
  <div><span class="eyebrow">Новое · версия 2.0</span>
    <h1>Запускайте продукты <span class="grad">в 10 раз быстрее</span></h1>
    <p>Nimbus — платформа для команд, которые хотят деплоить, анализировать и масштабировать веб-приложения без DevOps-рутины.</p>
    <div class="hero-actions"><a href="/signup" class="btn btn-primary">Начать бесплатно ${icon.arrow}</a><a href="/demo" class="btn btn-ghost">Смотреть демо</a></div>
  </div>
  <img class="hero-image" src="/img/hero.jpg" alt="Дашборд Nimbus" width="1200" height="800">
</div></section>
<section class="logos"><div class="container"><p>Нам доверяют команды из 2 000+ компаний</p>
  <div class="logo-row">${['acme', 'globex', 'initech', 'umbrella', 'hooli', 'stark'].map((l) => `<img src="/logos/${l}.svg" alt="${l[0].toUpperCase() + l.slice(1)}">`).join('')}</div></div></section>
<section class="section" id="features"><div class="container">
  <div class="section-head"><h2>Всё, что нужно для роста</h2><p>Инструменты, которые обычно требуют пяти разных сервисов, — в одной платформе.</p></div>
  <div class="features-grid">${features.map(([i, t, d]) => `<article class="feature-card"><div class="feature-icon">${icon[i]}</div><h3>${t}</h3><p>${d}</p></article>`).join('')}</div>
</div></section>
<section class="section stats"><div class="container stats-grid">
  ${[['99.99%', 'аптайм'], ['300+', 'точек CDN'], ['12 мс', 'средний отклик'], ['2 000+', 'компаний']].map(([v, l]) => `<div><div class="stat-value">${v}</div><div class="stat-label">${l}</div></div>`).join('')}
</div></section>
${pricingSection('Простые и честные тарифы')}
<section class="section"><div class="container"><div class="section-head"><h2>Что говорят клиенты</h2></div>
  <div class="testimonials-grid">${[['Мы сократили время релиза с недели до часа. Nimbus — лучшее вложение года.', 'Анна Петрова', 'CTO, Acme', 1], ['Наконец-то аналитика и деплой в одном месте. Команда в восторге.', 'Игорь Смирнов', 'Head of Product, Globex', 2], ['Поддержка отвечает за минуты, а не за дни. Рекомендую.', 'Мария Ким', 'Founder, Hooli', 3]].map(([q, n, r, i]) => `
    <figure class="testimonial"><blockquote>«${q}»</blockquote><figcaption><img src="/img/avatar-${i}.jpg" alt="${n}"><div><div class="name">${n}</div><div class="role">${r}</div></div></figcaption></figure>`).join('')}
  </div></div></section>
<section class="section"><div class="container"><div class="section-head"><h2>Как это работает</h2></div>
  <div class="tabs-list" role="tablist">
    <button class="tab" role="tab" aria-selected="true" aria-controls="p1" id="t1">Подключите репозиторий</button>
    <button class="tab" role="tab" aria-selected="false" aria-controls="p2" id="t2">Настройте окружения</button>
    <button class="tab" role="tab" aria-selected="false" aria-controls="p3" id="t3">Запустите релиз</button>
  </div>
  <div class="tab-panel" role="tabpanel" id="p1"><h3>Шаг 1. GitHub, GitLab или Bitbucket</h3><p>Импортируйте проект за пару кликов — Nimbus сам определит фреймворк.</p></div>
  <div class="tab-panel" role="tabpanel" id="p2" hidden><h3>Шаг 2. Preview и Production</h3><p>Каждая ветка получает собственное preview-окружение с уникальным URL.</p></div>
  <div class="tab-panel" role="tabpanel" id="p3" hidden><h3>Шаг 3. Один клик — и готово</h3><p>Атомарные релизы с мгновенным откатом к любой предыдущей версии.</p></div>
</div></section>
${faq}
<section class="section contact"><div class="container"><div class="section-head"><h2>Свяжитесь с нами</h2><p>Ответим в течение одного рабочего дня.</p></div>
  <form class="contact-form" action="/api/contact" method="post">
    <label for="name">Имя<input id="name" name="name" placeholder="Иван Иванов" required></label>
    <label for="email">Email<input id="email" type="email" name="email" placeholder="you@company.com" required></label>
    <label for="topic">Тема<select id="topic" name="topic"><option>Продажи</option><option>Поддержка</option><option>Партнёрство</option></select></label>
    <label for="msg">Сообщение<textarea id="msg" name="message" rows="4" placeholder="Расскажите о задаче"></textarea></label>
    <button type="submit" class="btn btn-primary">Отправить заявку</button>
  </form></div></section>
<section class="cta-band"><h2>Готовы ускорить релизы?</h2><p>Присоединяйтесь к 2 000+ командам, которые уже работают с Nimbus.</p><a href="/signup" class="btn">Начать бесплатно</a></section>`;
const about = `
<section class="section"><div class="container prose"><h1>Мы строим облако, которое не мешает работать</h1>
<p>Nimbus основан в 2019 году инженерами, уставшими от бесконечной настройки инфраструктуры. Сегодня нас 120 человек в 9 странах.</p></div></section>
<section class="section"><div class="container"><div class="section-head"><h2>Команда</h2></div><div class="team-grid">
${[['Алексей Орлов', 'CEO'], ['Елена Волкова', 'CTO'], ['Дмитрий Ли', 'VP Engineering'], ['Ольга Новикова', 'Head of Design']].map(([n, r], i) => `<div class="member"><img src="/img/team-${i + 1}.jpg" alt="${n}"><h3>${n}</h3><p>${r}</p></div>`).join('')}
</div></div></section>`;
const blog = `
<section class="section"><div class="container"><div class="section-head"><h2>Блог</h2><p>Новости продукта и инженерные истории.</p></div><div class="posts-grid">
${[1, 2, 3].map((i) => `<a class="post-card" href="/blog/post-${i}"><img src="/blog/cover-${i}.webp" alt="Обложка поста ${i}"><div class="body"><time datetime="2025-0${i}-10">10.0${i}.2025</time><h3>${['Nimbus 2.0: что нового', 'Как мы ускорили CDN на 40%', 'Гайд по preview-окружениям'][i - 1]}</h3><p>Короткое описание статьи номер ${i}.</p></div></a>`).join('')}
</div></div></section>`;
const post = (i) => `<section class="section"><article class="container prose"><h1>${['Nimbus 2.0: что нового', 'Как мы ускорили CDN на 40%', 'Гайд по preview-окружениям'][i - 1]}</h1><p>Это полный текст статьи номер ${i}. Здесь рассказывается о деталях реализации и планах команды.</p><p>Второй абзац статьи ${i}.</p></article></section>`;
const files = {
  'index.html': page('Nimbus — облачная платформа для продуктовых команд', 'Деплой, аналитика и масштабирование в одном месте.', home),
  'pricing.html': page('Тарифы — Nimbus', 'Простые и честные тарифы Nimbus.', pricingSection('Тарифы Nimbus') + faq),
  'about.html': page('О компании — Nimbus', 'Команда Nimbus.', about),
  'blog.html': page('Блог — Nimbus', 'Блог Nimbus.', blog),
  'blog/post-1.html': page('Nimbus 2.0: что нового — Nimbus', 'Пост 1', post(1)),
  'blog/post-2.html': page('Как мы ускорили CDN — Nimbus', 'Пост 2', post(2)),
  'blog/post-3.html': page('Гайд по preview — Nimbus', 'Пост 3', post(3)),
  'private/admin.html': page('Private', 'private', '<p>secret</p>'),
};
for (const [f, html] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), html); }
console.log('fixture written:', Object.keys(files).length, 'pages');
