const ICONS = { dorucak: '☕', rucak: '\u{1F35D}', vecera: '\u{1F319}' };
const WEEK_SHORT = ['нед', 'пон', 'уто', 'сре', 'чет', 'пет', 'суб'];
const WEEK_LONG = ['недеља', 'понедељак', 'уторак', 'среда', 'четвртак', 'петак', 'субота'];
const MONTHS = ['јануар', 'фебруар', 'март', 'април', 'мај', 'јун', 'јул', 'август', 'септембар', 'октобар', 'новембар', 'децембар'];

const el = (id) => document.getElementById(id);
const state = { meta: null, days: new Map(), selected: null, prefs: { dorucak: true, rucak: true, vecera: true } };

/* ---------- Помоћне функције за датуме ---------- */

const shift = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const weekdayIndex = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const human = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d}. ${MONTHS[m - 1]}`;
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* ---------- Учитавање података ---------- */

async function load() {
  const isRefresh = Boolean(state.meta);
  const keepScroll = window.scrollY;

  state.meta = await (await fetch('/api/meta')).json();
  const first = state.meta.range?.first;
  const last = state.meta.range?.last;
  const floor = shift(state.meta.today, -3);
  const from = first ? (first > floor ? first : floor) : state.meta.today;
  const to = last || shift(state.meta.today, 14);

  const data = await (await fetch(`/api/menu?from=${from}&to=${to}`)).json();
  state.days = new Map(data.days.map((day) => [day.date, day]));

  const params = new URLSearchParams(location.search);
  const requested = params.get('dan');
  state.selected = state.days.has(requested)
    ? requested
    : state.days.has(state.meta.today)
      ? state.meta.today
      : [...state.days.keys()][0] || state.meta.today;

  renderStrip();
  renderDay();
  renderFooter();
  renderUpNext();
  load.lastAt = Date.now();

  // Освежавање не сме да помери страницу под прстом корисника.
  if (isRefresh) {
    window.scrollTo(0, keepScroll);
    return;
  }

  // Долазак из обавештења: помери приказ на тражени оброк.
  const focus = params.get('obrok');
  if (focus) {
    // Без "smooth": глатко померање прегледач прекине док се страна још слаже.
    requestAnimationFrame(() => el(`meal-${focus}`)?.scrollIntoView({ block: 'center' }));
  }
}

/* ---------- Приказ ---------- */

function renderStrip() {
  const strip = el('strip');
  strip.replaceChildren();
  for (const date of state.days.keys()) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (date === state.meta.today ? ' today' : '');
    chip.setAttribute('aria-selected', String(date === state.selected));
    chip.innerHTML = `<small>${WEEK_SHORT[weekdayIndex(date)]}</small><strong>${Number(date.slice(8))}</strong>`;
    chip.addEventListener('click', () => {
      state.selected = date;
      history.replaceState(null, '', date === state.meta.today ? '/' : `/?dan=${date}`);
      renderStrip();
      renderDay();
      renderUpNext();
    });
    strip.append(chip);
  }
  // Трака се помера само водоравно. scrollIntoView би овде повукао и целу
  // страницу навише, што квари долазак из обавештења на одређени оброк.
  const active = strip.querySelector('[aria-selected="true"]');
  if (active) strip.scrollLeft = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
}

/**
 * Следећи оброк који тек предстоји. Кад се данашњи дан заврши,
 * прелази на сутрашњи доручак, исто као што ради и обавештење у 22:00.
 */
function nextUp() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const meal of state.meta.meals) {
    const [h, m] = meal.startsAt.split(':').map(Number);
    if (minutes < h * 60 + m) return { date: state.meta.today, meal, minutesAway: h * 60 + m - minutes };
  }
  const tomorrow = shift(state.meta.today, 1);
  const first = state.meta.meals[0];
  const [h, m] = first.startsAt.split(':').map(Number);
  return { date: tomorrow, meal: first, minutesAway: 24 * 60 - minutes + h * 60 + m };
}

function renderDay() {
  const day = state.days.get(state.selected);
  const isToday = state.selected === state.meta.today;
  el('dayHead').innerHTML = `<h2>${isToday ? 'Данас' : WEEK_LONG[weekdayIndex(state.selected)]}, ${human(state.selected)}</h2>
    <p>${isToday ? WEEK_LONG[weekdayIndex(state.selected)] : ''}</p>`;

  el('empty').hidden = Boolean(day);
  const container = el('meals');
  container.replaceChildren();
  if (!day) return;

  const next = nextUp();
  for (const meal of state.meta.meals) {
    const items = day.meals[meal.key] || [];
    const card = document.createElement('section');
    const isNext = next.date === state.selected && next.meal.key === meal.key;
    card.className = 'meal' + (isNext ? ' next' : '');
    card.id = `meal-${meal.key}`;
    const list = items.length
      ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p class="none">Није предвиђено.</p>';
    card.innerHTML = `<div class="meal-head"><span class="ico" aria-hidden="true">${ICONS[meal.key]}</span>`
      + `<h3>${meal.label}</h3><span class="time">од ${meal.startsAt}</span></div>${list}`;
    container.append(card);
  }
}

function renderUpNext() {
  const box = el('upNext');
  clearInterval(renderUpNext.timer);

  const tick = () => {
    const next = nextUp();
    if (!state.days.has(next.date)) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    state.next = next;
    const hours = Math.floor(next.minutesAway / 60);
    const when = next.date === state.meta.today ? '' : 'сутра ';
    box.innerHTML = `<span>Следећи оброк: <b>${next.meal.label}</b> ${when}у ${next.meal.startsAt}</span>`
      + `<span class="cd">за ${hours > 0 ? `${hours} ч ` : ''}${next.minutesAway % 60} мин</span>`;
  };

  tick();
  renderUpNext.timer = setInterval(tick, 30000);
}

function renderFooter() {
  const source = state.meta.source;
  const foot = el('foot');
  if (!source) {
    foot.replaceChildren();
    return;
  }
  const parts = [];
  if (source.allergens) parts.push(`<div><b>Алерго инфо:</b> ${escapeHtml(source.allergens)}</div>`);
  if (source.note) parts.push(`<div>${escapeHtml(source.note)}</div>`);
  if (source.url && source.url.startsWith('http')) {
    parts.push(`<div>Извор: <a href="${escapeHtml(source.url)}" rel="noopener">званични PDF јеловник</a></div>`);
  }
  if (source.fetchedAt) {
    parts.push(`<div>Ажурирано ${new Date(source.fetchedAt).toLocaleDateString('sr-RS')}</div>`);
  }
  foot.innerHTML = parts.join('');
}

/* ---------- Обавештења ---------- */

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function openSheet() {
  const prefs = el('prefs');
  prefs.replaceChildren();
  for (const meal of state.meta.meals) {
    const li = document.createElement('li');
    const id = `pref-${meal.key}`;
    li.innerHTML = `<input type="checkbox" id="${id}" ${state.prefs[meal.key] ? 'checked' : ''}>`
      + `<label for="${id}">${meal.label}<div class="when">обавештење у ${meal.notifyAt}</div></label>`;
    prefs.append(li);
  }

  const note = el('sheetNote');
  const save = el('sheetSave');
  note.hidden = true;
  save.disabled = false;

  if (!state.meta.pushEnabled) {
    note.hidden = false;
    note.textContent = 'Обавештења тренутно нису подешена на серверу.';
    save.disabled = true;
  } else if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    note.hidden = false;
    note.textContent = 'Овај прегледач не подржава обавештења.';
    save.disabled = true;
  } else if (isIos() && !isStandalone()) {
    note.hidden = false;
    note.textContent = 'На iPhone-у обавештења раде тек кад додаш апликацију на почетни екран: дугме Подели, па „Додај на почетни екран”.';
    save.disabled = true;
  }

  el('sheet').hidden = false;
}

async function saveSubscription() {
  const prefs = Object.fromEntries(state.meta.meals.map((meal) => [meal.key, el(`pref-${meal.key}`).checked]));
  state.prefs = prefs;
  localStorage.setItem('prefs', JSON.stringify(prefs));

  const registration = await navigator.serviceWorker.ready;
  const noneSelected = Object.values(prefs).every((value) => !value);

  if (noneSelected) {
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: existing.endpoint }),
      });
      await existing.unsubscribe();
    }
    el('bellDot').hidden = true;
    return 'Обавештења су искључена.';
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'Дозвола за обавештења није дата.';

  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.meta.vapidPublicKey),
    }));

  await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON(), prefs }),
  });
  el('bellDot').hidden = false;
  return 'Спремно. Јавићемо ти пред сваки оброк.';
}

/* ---------- Повезивање ---------- */

el('bell').addEventListener('click', openSheet);

// Трака „следећи оброк” води право на тај дан и оброк.
el('upNext').addEventListener('click', () => {
  const next = state.next;
  if (!next || !state.days.has(next.date)) return;
  state.selected = next.date;
  history.replaceState(null, '', next.date === state.meta.today ? '/' : `/?dan=${next.date}`);
  renderStrip();
  renderDay();
  el(`meal-${next.meal.key}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

el('sheetClose').addEventListener('click', () => { el('sheet').hidden = true; });
el('sheet').addEventListener('click', (event) => {
  if (event.target === el('sheet')) el('sheet').hidden = true;
});
el('sheetSave').addEventListener('click', async () => {
  const save = el('sheetSave');
  const note = el('sheetNote');
  save.disabled = true;
  try {
    note.textContent = await saveSubscription();
  } catch (error) {
    note.textContent = `Није успело: ${error.message}`;
  }
  note.hidden = false;
  save.disabled = false;
});

try {
  const stored = JSON.parse(localStorage.getItem('prefs') || 'null');
  if (stored) state.prefs = stored;
} catch {
  /* нема сачуваних подешавања */
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('SW:', error.message));
  navigator.serviceWorker.ready
    .then((registration) => registration.pushManager.getSubscription())
    .then((subscription) => { el('bellDot').hidden = !subscription; })
    .catch(() => {});
}

// Освежи податке кад се корисник врати у апликацију, али не на сваки повратак:
// јеловник се мења двапут месечно, па је довољно на два минута.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (load.lastAt && Date.now() - load.lastAt < 120000) return;
  load().catch(() => {});
});

load().catch((error) => {
  el('empty').hidden = false;
  el('empty').innerHTML = `<p>Подаци тренутно нису доступни.</p><p class="muted">${escapeHtml(error.message)}</p>`;
});
