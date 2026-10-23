'use strict';

/* --------------------------------------------------------------------------
   tasklove. — ilova hayoti, auth, real-vaqt va harakatlar
   -------------------------------------------------------------------------- */

let authSubmitting = false;
let logoutBusy = false;
let eventsBound = false;

/* --------------------------------------------------------------------------
   Ekranlar
   -------------------------------------------------------------------------- */

function hideBoot() {
  if (dom.bootScreen) dom.bootScreen.hidden = true;
}

function showAuth() {
  disconnectStream();
  clearTimeout(app.refreshTimer);
  clearTimeout(app.reconnectTimer);
  app.refreshTimer = null;
  app.reconnectTimer = null;
  app.refreshing = false;
  app.queuedRefresh = false;
  app.data = null;
  app.route = { name: 'board' };
  app.filter = 'active';

  if (app.modal) closeModal({ restoreFocus: false });
  hideBoot();
  dom.appScreen.hidden = true;
  dom.authScreen.hidden = false;
  dom.body.classList.remove('modal-open');
  setAuthMode('login');
  dom.authForm.reset();
  clearAuthError();
  if (location.hash !== '#/kirish') {
    history.replaceState(null, '', '#/kirish');
  }
  document.title = 'Kirish — tasklove.';
  window.scrollTo(0, 0);
}

function enterApp() {
  hideBoot();
  dom.authScreen.hidden = true;
  dom.appScreen.hidden = false;
  dom.body.classList.remove('modal-open');
  renderApp();
  connectStream();
}

function handleUnauthorized() {
  if (dom.authScreen.hidden === false) return;
  const hadSession = Boolean(app.data);
  disconnectStream();
  app.data = null;
  showAuth();
  if (hadSession) {
    toast('Sessiya tugadi', 'Xavfsizlik uchun qaytadan kirishingiz kerak.', 'error');
  }
}

/* --------------------------------------------------------------------------
   Marshrutlar
   -------------------------------------------------------------------------- */

function parseRoute() {
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const path = raw.split('?')[0].replace(/\/+$/, '');

  if (!path || path === 'board' || path === 'kirish') return { name: 'board' };
  if (path === 'people') return { name: 'people' };
  if (path === 'me') return { name: 'profile', self: true, userId: null };

  const match = /^profile\/([A-Za-z0-9-]+)$/.exec(path);
  if (match) {
    return { name: 'profile', self: false, userId: match[1] };
  }

  return { name: 'board' };
}

function handleRouteChange() {
  if (!app.data) return;
  app.route = parseRoute();
  if (app.modal) closeModal({ restoreFocus: false });
  renderApp();
  window.scrollTo(0, 0);
}

function navigate(path, { replace = false } = {}) {
  const normalized = String(path).startsWith('#')
    ? String(path)
    : `#/${String(path).replace(/^\/+/, '')}`;

  if (location.hash === normalized) {
    handleRouteChange();
    return;
  }

  if (replace) {
    history.replaceState(null, '', normalized);
    handleRouteChange();
  } else {
    location.hash = normalized;
  }
}

/* --------------------------------------------------------------------------
   Real-vaqt
   -------------------------------------------------------------------------- */

function setStreamStatus(online, label = null) {
  app.streamOnline = Boolean(online);
  const pill = document.querySelector('[data-live-pill]');
  const word = document.querySelector('[data-live-word]');
  if (pill) pill.classList.toggle('is-reconnecting', !online);
  if (word) word.textContent = label || (online ? 'onlayn' : 'qayta ulanish');
}

const POLL_INTERVAL_MS = 3000;
const POLL_HIDDEN_INTERVAL_MS = 15000;

function disconnectStream() {
  if (app.events) {
    app.events.stopped = true;
    clearTimeout(app.events.timer);
    app.events = null;
  }
  clearTimeout(app.reconnectTimer);
  app.reconnectTimer = null;
  setStreamStatus(false, 'ulanmoqda');
}

// Serverless muhitda doimiy ulanish yo‘q, shuning uchun hodisalarni
// qisqa oraliqlarda so‘rab olamiz (/api/events?after=<cursor>).
function connectStream() {
  if (!app.data) return;
  disconnectStream();
  setStreamStatus(false, 'ulanmoqda');

  const poller = { cursor: null, timer: null, stopped: false, failures: 0 };
  app.events = poller;

  const schedule = (delay) => {
    if (poller.stopped) return;
    clearTimeout(poller.timer);
    poller.timer = setTimeout(tick, delay);
  };

  async function tick() {
    if (poller.stopped || !app.data) return;
    const query = poller.cursor === null ? '' : `?after=${encodeURIComponent(poller.cursor)}`;
    let payload;
    try {
      payload = await api(`/api/events${query}`, { allow401: true });
    } catch {
      if (poller.stopped) return;
      poller.failures += 1;
      setStreamStatus(false, 'qayta ulanish');
      schedule(Math.min(POLL_INTERVAL_MS * 2 ** poller.failures, 30000));
      return;
    }
    if (poller.stopped) return;
    if (payload === null) {
      handleUnauthorized();
      return;
    }

    const wasOffline = poller.failures > 0 || poller.cursor === null;
    poller.failures = 0;
    poller.cursor = payload.cursor;
    setStreamStatus(true);

    if (Array.isArray(payload.onlineUserIds) && app.data) {
      app.data.onlineUserIds = [...new Set(payload.onlineUserIds)];
      updatePresenceUI();
    }

    const events = Array.isArray(payload.events) ? payload.events : [];
    for (const event of events) handleRealtimeNotification(event);
    // Aloqa uzilgan paytda o‘tkazib yuborilgan o‘zgarishlarni ham olamiz.
    if (events.length || wasOffline) scheduleRefresh(events[events.length - 1] || null, 120);

    schedule(document.hidden ? POLL_HIDDEN_INTERVAL_MS : POLL_INTERVAL_MS);
  }

  tick();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && app.events && !app.events.stopped) {
    clearTimeout(app.events.timer);
    app.events.timer = setTimeout(() => connectStream(), 50);
  }
});

function scheduleRefresh(meta, delay = 170) {
  clearTimeout(app.refreshTimer);
  app.refreshTimer = setTimeout(() => {
    app.refreshTimer = null;
    refreshState({ silent: true });
  }, delay);
  if (meta) {
    // notification schedule ichida emas — sync eventda darhol ko'rsatiladi
  }
}

async function refreshState({ silent = true } = {}) {
  if (!app.data) return;
  if (app.refreshing) {
    app.queuedRefresh = true;
    return;
  }

  clearTimeout(app.refreshTimer);
  app.refreshTimer = null;
  app.refreshing = true;
  app.queuedRefresh = false;

  try {
    const data = await api('/api/state');
    if (!app.data) return;
    app.data = data;
    renderApp();
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!silent) {
      toast('Yangilab bo‘lmadi', error.message, 'error');
    }
  } finally {
    app.refreshing = false;
    if (app.queuedRefresh && app.data) {
      app.queuedRefresh = false;
      app.refreshTimer = setTimeout(() => {
        app.refreshTimer = null;
        refreshState({ silent: true });
      }, 60);
    }
  }
}

function handleRealtimeNotification(meta) {
  if (!app.data || !meta || !meta.kind) return;
  const me = app.data.me;
  if (meta.actorId === me.id) return;

  const recipients = Array.isArray(meta.recipients) ? meta.recipients : [];
  const isOpen = meta.mode === 'open';

  if (meta.kind === 'task.created') {
    if (isOpen) {
      toast(
        'Yangi ochiq vazifa',
        `${meta.actorName} tashladi: “${meta.title}”. Birinchi bo‘lish imkoni sizda!`,
        'info',
      );
    } else if (recipients.includes(me.id)) {
      toast(
        'Sizga vazifa tashlandi',
        `${meta.actorName}: “${meta.title}”. Birinchi bo‘lib bajaring!`,
        'info',
      );
    }
  } else if (meta.kind === 'task.completed') {
    if (isOpen || recipients.includes(me.id)) {
      toast(
        'Birinchi bo‘ldi!',
        `${meta.actorName} “${meta.title}” vazifasini birinchi bo‘lib bajardi. +1 ball.`,
        'success',
      );
    }
  } else if (meta.kind === 'task.deleted') {
    if (recipients.includes(me.id)) {
      toast(
        'Vazifa olib tashlandi',
        `${meta.actorName} “${meta.title}” vazifasini bekor qildi.`,
        'info',
      );
    }
  } else if (meta.kind === 'user.deleted') {
    if (app.route.name === 'profile' && app.route.userId === meta.actorId) {
      toast('Profil o‘chirildi', `${meta.actorName} o‘z akkauntini o‘chirdi.`, 'info');
    }
  }
}

/* --------------------------------------------------------------------------
   Auth
   -------------------------------------------------------------------------- */

async function handleAuthSubmit(form) {
  if (authSubmitting) return;

  clearAuthError();
  const mode = app.authMode;
  const isRegister = mode === 'register';
  const name = dom.authName.value.trim();
  const username = dom.authUsername.value.trim().toLowerCase();
  const password = dom.authPassword.value;

  if (isRegister && name.length < 2) {
    showFormError(dom.authError, 'Ismingiz kamida 2 ta belgidan iborat bo‘lishi kerak.');
    dom.authName.focus();
    return;
  }
  if (name.length > 40) {
    showFormError(dom.authError, 'Ism juda uzun.');
    dom.authName.focus();
    return;
  }
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    showFormError(dom.authError, 'Taxallus 3–20 belgidan iborat bo‘lib, faqat lotin harflari, raqamlar va _ belgisidan tashkil topishi kerak.');
    dom.authUsername.focus();
    return;
  }
  if (password.length < 8) {
    showFormError(dom.authError, 'Parol kamida 8 ta belgidan iborat bo‘lishi kerak.');
    dom.authPassword.focus();
    return;
  }

  authSubmitting = true;
  setButtonBusy(dom.authSubmit, true, isRegister ? 'Hisob ochilmoqda…' : 'Kirilmoqda…');

  try {
    await api(isRegister ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: isRegister ? { name, username, password } : { username, password },
    });

    const data = await api('/api/state');
    app.data = data;
    app.filter = 'active';
    app.route = { name: 'board' };
    history.replaceState(null, '', '#/board');
    dom.authForm.reset();
    enterApp();
    toast(
      isRegister ? 'Xush kelibsiz, yurak!' : 'Yana ko‘rishdik!',
      isRegister
        ? 'Hisobingiz tayyor. Birinchi vazifangizni tashlang yoki do‘stlaringiznikini bajaring.'
        : 'Bugungi kichik sarguzashtlar sizni kutmoqda.',
      'success',
    );
  } catch (error) {
    if (error.status === 401 && !isRegister) {
      showFormError(dom.authError, "Taxallus yoki parol noto‘g‘ri.");
    } else if (error.status === 401) {
      handleUnauthorized();
    } else {
      showFormError(dom.authError, error.message);
    }
  } finally {
    authSubmitting = false;
    setButtonBusy(dom.authSubmit, false);
  }
}

async function handleLogout() {
  if (logoutBusy) return;
  logoutBusy = true;
  const first = app.data;
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    if (error.status === 401) {
      // Sessiya allaqachon yo‘q — baribir chiqamiz.
    } else {
      toast('Chiqishda xatolik', error.message, 'error');
    }
  } finally {
    logoutBusy = false;
    if (first) {
      disconnectStream();
      app.data = null;
      showAuth();
      toast('Hisobdan chiqdingiz', 'Yana qaytib keling — sizni sog‘indik.', 'info');
    }
  }
}

/* --------------------------------------------------------------------------
   Vazifa yaratish / tahrirlash / o‘chirish formalari
   -------------------------------------------------------------------------- */

async function handleCreateTaskSubmit(form) {
  const errorElement = form.querySelector('[data-form-error]');
  const submit = document.getElementById('createTaskSubmit');
  showFormError(errorElement, '');

  const title = form.elements.title.value.trim();
  const description = form.elements.description.value.trim();
  const mode = form.querySelector('input[name="mode"]:checked')?.value;
  const category = form.querySelector('input[name="category"]:checked')?.value || 'other';
  const dueDate = form.elements.due_date.value || null;
  const participants = [...form.querySelectorAll('input[name="participant"]:checked')]
    .map((input) => input.value);

  if (title.length < 3) {
    showFormError(errorElement, 'Vazifa nomi kamida 3 ta belgidan iborat bo‘lishi kerak.');
    form.elements.title.focus();
    return;
  }
  if (!['solo', 'shared', 'open'].includes(mode)) {
    showFormError(errorElement, 'Vazifa turini tanlang.');
    return;
  }
  if (mode === 'solo' && participants.length !== 1) {
    showFormError(errorElement, 'Shaxsiy vazifa uchun bitta yurakni tanlang.');
    form.querySelector('input[name="participant"]')?.focus();
    return;
  }
  if (mode === 'shared' && participants.length < 1) {
    showFormError(errorElement, 'Birgalikdagi vazifa uchun kamida bitta yurakni tanlang.');
    form.querySelector('input[name="participant"]')?.focus();
    return;
  }

  setButtonBusy(submit, true, 'Tashlanmoqda…');
  try {
    await api('/api/tasks', {
      method: 'POST',
      body: {
        title,
        description,
        mode,
        category,
        due_date: dueDate,
        participant_ids: mode === 'open' ? [] : participants,
      },
    });
    closeModal({ restoreFocus: false });
    app.filter = 'active';
    toast('Vazifa tashlandi', 'Endi eng shirin qismi — kim birinchi bo‘lishini kutish.', 'success');
    await refreshState({ silent: true });
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    showFormError(errorElement, error.message);
  } finally {
    setButtonBusy(submit, false);
  }
}

async function handleEditProfileSubmit(form) {
  const errorElement = form.querySelector('[data-form-error]');
  const submit = document.getElementById('editProfileSubmit');
  showFormError(errorElement, '');

  const displayName = form.elements.display_name.value.trim();
  const bio = form.elements.bio.value.trim();
  const emoji = form.querySelector('input[name="emoji"]:checked')?.value;
  const accent = form.querySelector('input[name="accent"]:checked')?.value;

  if (displayName.length < 2) {
    showFormError(errorElement, 'Ism kamida 2 ta belgidan iborat bo‘lishi kerak.');
    form.elements.display_name.focus();
    return;
  }
  if (bio.length > 180) {
    showFormError(errorElement, 'Bio 180 ta belgidan oshmasligi kerak.');
    form.elements.bio.focus();
    return;
  }

  setButtonBusy(submit, true, 'Saqlanmoqda…');
  try {
    await api('/api/profile', {
      method: 'PATCH',
      body: {
        display_name: displayName,
        bio,
        emoji,
        accent,
      },
    });
    closeModal({ restoreFocus: false });
    toast('Profil yangilandi', 'Yangi ko‘rinish barcha yuraklarga ko‘rindi.', 'success');
    await refreshState({ silent: true });
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    showFormError(errorElement, error.message);
  } finally {
    setButtonBusy(submit, false);
  }
}

async function handleDeleteAccountSubmit(form) {
  const errorElement = form.querySelector('[data-form-error]');
  const submit = document.getElementById('deleteAccountSubmit');
  const me = currentUser();
  if (!me) return;
  showFormError(errorElement, '');

  const password = form.elements.password.value;
  const confirmRaw = form.elements.confirm.value.trim();
  const confirm = confirmRaw.replace(/^@/, '');

  if (!password) {
    showFormError(errorElement, 'Parolingizni kiriting.');
    form.elements.password.focus();
    return;
  }
  if (confirm !== me.username) {
    showFormError(errorElement, `Tasdiqlash uchun ${me.username} deb yozing.`);
    form.elements.confirm.focus();
    return;
  }

  setButtonBusy(submit, true, 'O‘chirilmoqda…');
  try {
    await api('/api/account', {
      method: 'DELETE',
      body: { password, confirm },
    });
    closeModal({ restoreFocus: false });
    disconnectStream();
    app.data = null;
    showAuth();
    toast(
      'Akkaunt o‘chirildi',
      'Barcha shaxsiy izlaringiz tozalandi. Yana ko‘rishguncha.',
      'info',
    );
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    showFormError(errorElement, error.message);
  } finally {
    setButtonBusy(submit, false);
  }
}

/* --------------------------------------------------------------------------
   Tugmalar orqali bajariladigan amallar
   -------------------------------------------------------------------------- */

async function confirmTaskComplete(button) {
  const taskId = button.dataset.taskId;
  const task = app.data?.tasks.find((item) => item.id === taskId);
  if (!task) {
    closeModal({ restoreFocus: false });
    toast('Vazifa topilmadi', 'Oqim yangilangan. Qayta urinib ko‘ring.', 'error');
    return;
  }

  setButtonBusy(button, true, 'Saqlanmoqda…');
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/complete`, { method: 'POST' });
    closeModal({ restoreFocus: false });
    heartBurst();
    toast('Yana bir g‘alaba!', `“${task.title}” — +1 ball hisobingizda.`, 'success');
    await refreshState({ silent: true });
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    if (error.status === 409) {
      closeModal({ restoreFocus: false });
      await refreshState({ silent: true });
      toast('Afsus, sizdan tezroq bo‘lishdi', 'Bu vazifani boshqa yurak birinchi bo‘lib bajardi. Yangisini sinab ko‘ring.', 'info');
    } else {
      toast('Bajara olmadik', error.message, 'error');
      setButtonBusy(button, false);
    }
  }
}

async function confirmTaskDelete(button) {
  const taskId = button.dataset.taskId;
  const task = app.data?.tasks.find((item) => item.id === taskId);
  setButtonBusy(button, true, 'O‘chirilmoqda…');
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    closeModal({ restoreFocus: false });
    toast('Vazifa o‘chirildi', task ? `“${task.title}” oqimdan olib tashlandi.` : '', 'info');
    await refreshState({ silent: true });
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized();
      return;
    }
    closeModal({ restoreFocus: false });
    await refreshState({ silent: true });
    toast('Vazifani o‘chirib bo‘lmadi', error.message, 'error');
  }
}

function handleAction(node) {
  const action = node.dataset.action;
  if (!action) return;

  if (action === 'set-filter') {
    app.filter = node.dataset.filter || 'active';
    renderApp();
    return;
  }

  if (action === 'go-mine') {
    app.filter = 'mine';
    if (app.route.name !== 'board') navigate('board');
    else renderApp();
    return;
  }

  if (action === 'open-create') {
    if (!app.data) return;
    openCreateDialog({
      targetId: node.dataset.targetId || null,
      mode: node.dataset.createMode || null,
    });
    return;
  }

  if (action === 'complete-task') {
    openCompleteDialog(node.dataset.taskId);
    return;
  }

  if (action === 'confirm-complete') {
    confirmTaskComplete(node);
    return;
  }

  if (action === 'delete-task') {
    openDeleteTaskDialog(node.dataset.taskId);
    return;
  }

  if (action === 'confirm-delete-task') {
    confirmTaskDelete(node);
    return;
  }

  if (action === 'edit-profile') {
    openEditProfileDialog();
    return;
  }

  if (action === 'delete-account') {
    openDeleteAccountDialog();
    return;
  }

  if (action === 'copy-invite') {
    copyInvite();
    return;
  }

  if (action === 'logout') {
    handleLogout();
  }
}

/* --------------------------------------------------------------------------
   Hodisalar
   -------------------------------------------------------------------------- */

function handleDocumentClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const passwordToggle = target.closest('[data-toggle-password]');
  if (passwordToggle) {
    event.preventDefault();
    const shell = passwordToggle.closest('.input-shell');
    const input = shell?.querySelector('input');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    passwordToggle.setAttribute('aria-label', show ? 'Parolni yashirish' : 'Parolni ko‘rsatish');
    const use = passwordToggle.querySelector('use');
    use?.setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    return;
  }

  const authModeButton = target.closest('[data-auth-mode]');
  if (authModeButton && !app.data) {
    event.preventDefault();
    setAuthMode(authModeButton.dataset.authMode);
    return;
  }

  const actionNode = target.closest('[data-action]');
  if (actionNode && app.data) {
    event.preventDefault();
    handleAction(actionNode);
  }
}

function handleDocumentSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  if (form.id === 'authForm') {
    event.preventDefault();
    handleAuthSubmit(form);
    return;
  }

  if (form.id === 'createTaskForm') {
    event.preventDefault();
    handleCreateTaskSubmit(form);
    return;
  }

  if (form.id === 'editProfileForm') {
    event.preventDefault();
    handleEditProfileSubmit(form);
    return;
  }

  if (form.id === 'deleteAccountForm') {
    event.preventDefault();
    handleDeleteAccountSubmit(form);
    return;
  }
}

function handleDocumentInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (dom.authForm.contains(target) && !dom.authError.hidden) {
    clearAuthError();
  }

  const form = target.closest('form');
  if (!form) return;
  const errorElement = form.querySelector('[data-form-error]');
  if (errorElement && !errorElement.hidden) {
    showFormError(errorElement, '');
  }
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;

  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('submit', handleDocumentSubmit);
  document.addEventListener('input', handleDocumentInput);
  window.addEventListener('hashchange', handleRouteChange);

  window.addEventListener('offline', () => {
    if (app.data) setStreamStatus(false, 'oflayn');
  });

  window.addEventListener('online', () => {
    if (!app.data) return;
    setStreamStatus(false, 'qayta ulanish');
    connectStream();
    refreshState({ silent: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app.data) {
      refreshState({ silent: true });
    }
  });
}

/* --------------------------------------------------------------------------
   Boshlanish
   -------------------------------------------------------------------------- */

async function boot() {
  setAuthMode('login');
  bindEvents();

  try {
    const data = await api('/api/state', { allow401: true });
    if (!data) {
      showAuth();
      return;
    }

    app.data = data;
    if (!location.hash || location.hash === '#/kirish') {
      history.replaceState(null, '', '#/board');
    }
    app.route = parseRoute();
    dom.bootScreen.hidden = true;
    dom.authScreen.hidden = true;
    dom.appScreen.hidden = false;
    renderApp();
    connectStream();
  } catch (error) {
    showAuth();
    if (error.status === 0) {
      toast('Server bilan aloqa yo‘q', 'Internet aloqasini tekshirib, sahifani yangilang.', 'error');
    }
  } finally {
    hideBoot();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
