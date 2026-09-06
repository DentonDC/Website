(function () {
  var STORAGE = "committee.v1";
  var view = document.getElementById("view");
  var nav = document.getElementById("nav");
  var who = document.getElementById("who");
  var state = { user: null, local: false, needsSetup: false, lastCode: "", flash: "" };

  var ROLE = {
    admin: "Председатель",
    treasurer: "Казначей",
    member: "Член комитета",
    parent: "Родитель",
  };

  var ROUTES = ["dashboard", "sbor", "kassa", "news", "docs", "people", "log"];

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function rub(cents) {
    return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format((Number(cents) || 0) / 100);
  }

  function when(iso) {
    if (!iso) return "";
    return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  }

  function route() {
    var hash = (location.hash || "#dashboard").replace(/^#\/?/, "") || "dashboard";
    return ROUTES.indexOf(hash) >= 0 ? hash : "dashboard";
  }

  function canMoney(user) {
    return user && (user.role === "admin" || user.role === "treasurer");
  }

  function canInvite(user) {
    return user && user.role === "admin";
  }

  function canPublish(user) {
    return user && (user.role === "admin" || user.role === "treasurer" || user.role === "member");
  }

  function canLog(user) {
    return canPublish(user);
  }

  function uid() {
    return crypto.randomUUID();
  }

  function now() {
    return new Date().toISOString();
  }

  function makeCode() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
    return out.slice(0, 4) + "-" + out.slice(4);
  }

  function hashCode(code) {
    var normalized = String(code || "").replace(/\s+/g, "").toUpperCase();
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized)).then(function (buf) {
      return Array.from(new Uint8Array(buf))
        .map(function (b) {
          return b.toString(16).padStart(2, "0");
        })
        .join("");
    });
  }

  function toCents(value) {
    var n = Number(String(value).replace(",", "."));
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * 100);
  }

  function emptyDb() {
    return {
      users: [],
      invites: [],
      announcements: [],
      collections: [],
      payments: [],
      treasury: [],
      documents: [],
      audit_log: [],
    };
  }

  function loadDb() {
    try {
      return Object.assign(emptyDb(), JSON.parse(localStorage.getItem(STORAGE) || "{}"));
    } catch (e) {
      return emptyDb();
    }
  }

  function saveDb(db) {
    localStorage.setItem(STORAGE, JSON.stringify(db));
  }

  function localLog(db, actorId, action, entity, entityId, details) {
    db.audit_log.unshift({
      id: uid(),
      actor_id: actorId,
      actor_name: (db.users.find(function (u) { return u.id === actorId; }) || {}).name || "",
      action: action,
      entity: entity,
      entity_id: entityId || null,
      details: details || null,
      created_at: now(),
    });
  }

  function publicUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      child_name: row.child_name || "",
      group_name: row.group_name || "",
      role: row.role,
      created_at: row.created_at,
    };
  }

  function withProgress(db, collection) {
    var members = db.users.map(function (person) {
      var paid = db.payments
        .filter(function (p) { return p.collection_id === collection.id && p.user_id === person.id; })
        .reduce(function (sum, p) { return sum + p.amount_cents; }, 0);
      var status = paid >= collection.amount_cents ? "paid" : paid > 0 ? "partial" : "unpaid";
      return {
        id: person.id,
        name: person.name,
        child_name: person.child_name,
        role: person.role,
        paid_cents: paid,
        status: status,
      };
    });
    var total = members.reduce(function (sum, m) { return sum + m.paid_cents; }, 0);
    return Object.assign({}, collection, { members: members, total_paid_cents: total });
  }

  var localApi = {
    session: function () {
      var db = loadDb();
      var raw = sessionStorage.getItem("committee.sid");
      var user = db.users.find(function (u) { return u.id === raw; });
      return Promise.resolve({
        user: publicUser(user),
        needs_setup: db.users.length === 0,
        db: false,
      });
    },
    setup: function (body) {
      var db = loadDb();
      if (db.users.length) return Promise.reject(new Error("already_setup"));
      var name = String(body.name || "").trim();
      if (name.length < 2) return Promise.reject(new Error("name_required"));
      var loginCode = makeCode();
      return hashCode(loginCode).then(function (hash) {
        var user = {
          id: uid(),
          name: name,
          child_name: String(body.child_name || "").trim(),
          group_name: String(body.group_name || "").trim(),
          role: "admin",
          login_code_hash: hash,
          created_at: now(),
        };
        db.users.push(user);
        localLog(db, user.id, "setup", "user", user.id, name);
        saveDb(db);
        sessionStorage.setItem("committee.sid", user.id);
        return { user: publicUser(user), login_code: loginCode };
      });
    },
    join: function (body) {
      var db = loadDb();
      var name = String(body.name || "").trim();
      if (name.length < 2) return Promise.reject(new Error("invalid_join"));
      return hashCode(body.code).then(function (hash) {
        var invite = db.invites.find(function (i) { return i.code_hash === hash && !i.used_at; });
        if (!invite) return Promise.reject(new Error("invite_not_found"));
        var loginCode = makeCode();
        return hashCode(loginCode).then(function (loginHash) {
          var user = {
            id: uid(),
            name: name,
            child_name: String(body.child_name || "").trim(),
            group_name: String(body.group_name || "").trim(),
            role: invite.role,
            login_code_hash: loginHash,
            created_at: now(),
          };
          invite.used_by = user.id;
          invite.used_at = now();
          db.users.push(user);
          localLog(db, user.id, "join", "user", user.id, name + " (" + invite.role + ")");
          saveDb(db);
          sessionStorage.setItem("committee.sid", user.id);
          return { user: publicUser(user), login_code: loginCode };
        });
      });
    },
    login: function (body) {
      var db = loadDb();
      return hashCode(body.code).then(function (hash) {
        var user = db.users.find(function (u) { return u.login_code_hash === hash; });
        if (!user) return Promise.reject(new Error("invalid_code"));
        localLog(db, user.id, "login", "session", user.id, null);
        saveDb(db);
        sessionStorage.setItem("committee.sid", user.id);
        return { user: publicUser(user) };
      });
    },
    logout: function () {
      sessionStorage.removeItem("committee.sid");
      return Promise.resolve({ ok: true });
    },
    members: function () {
      return Promise.resolve({ members: loadDb().users.map(publicUser) });
    },
    createInvite: function (body) {
      var db = loadDb();
      var role = ROLE[body.role] ? body.role : "parent";
      var code = makeCode();
      return hashCode(code).then(function (hash) {
        var invite = {
          id: uid(),
          code_hash: hash,
          code_hint: code.slice(-4),
          role: role,
          created_by: state.user.id,
          created_at: now(),
          used_at: null,
        };
        db.invites.unshift(invite);
        localLog(db, state.user.id, "invite_create", "invite", invite.id, role);
        saveDb(db);
        return { id: invite.id, code: code, role: role };
      });
    },
    invites: function () {
      return Promise.resolve({
        invites: loadDb().invites.map(function (i) {
          return { id: i.id, code_hint: i.code_hint, role: i.role, used_at: i.used_at, created_at: i.created_at };
        }),
      });
    },
    announcements: function () {
      var db = loadDb();
      return Promise.resolve({
        announcements: db.announcements.map(function (a) {
          var author = db.users.find(function (u) { return u.id === a.author_id; });
          return Object.assign({}, a, { author_name: author ? author.name : "" });
        }),
      });
    },
    createAnnouncement: function (body) {
      var db = loadDb();
      var item = {
        id: uid(),
        title: String(body.title || "").trim(),
        body: String(body.body || "").trim(),
        author_id: state.user.id,
        created_at: now(),
      };
      if (!item.title || !item.body) return Promise.reject(new Error("invalid_announcement"));
      db.announcements.unshift(item);
      localLog(db, state.user.id, "announce_create", "announcement", item.id, item.title);
      saveDb(db);
      return Promise.resolve({ id: item.id });
    },
    deleteAnnouncement: function (id) {
      var db = loadDb();
      db.announcements = db.announcements.filter(function (a) { return a.id !== id; });
      localLog(db, state.user.id, "announce_delete", "announcement", id, null);
      saveDb(db);
      return Promise.resolve({ ok: true });
    },
    collections: function () {
      var db = loadDb();
      return Promise.resolve({ collections: db.collections.map(function (c) { return withProgress(db, c); }) });
    },
    createCollection: function (body) {
      var db = loadDb();
      var cents = toCents(body.amount);
      var title = String(body.title || "").trim();
      if (!title || !cents) return Promise.reject(new Error("invalid_collection"));
      var item = {
        id: uid(),
        title: title,
        description: String(body.description || "").trim(),
        amount_cents: cents,
        due_date: body.due_date || null,
        created_by: state.user.id,
        created_at: now(),
        closed: 0,
      };
      db.collections.unshift(item);
      localLog(db, state.user.id, "collection_create", "collection", item.id, title);
      saveDb(db);
      return Promise.resolve({ id: item.id });
    },
    addPayment: function (collectionId, body) {
      var db = loadDb();
      var collection = db.collections.find(function (c) { return c.id === collectionId; });
      if (!collection || collection.closed) return Promise.reject(new Error("collection_closed"));
      var cents = toCents(body.amount);
      var payer = db.users.find(function (u) { return u.id === body.user_id; });
      if (!payer || !cents) return Promise.reject(new Error("invalid_payment"));
      var payment = {
        id: uid(),
        collection_id: collectionId,
        user_id: payer.id,
        amount_cents: cents,
        recorded_by: state.user.id,
        created_at: now(),
      };
      db.payments.push(payment);
      db.treasury.unshift({
        id: uid(),
        kind: "income",
        title: collection.title + " — " + payer.name,
        amount_cents: cents,
        receipt_url: "",
        payment_id: payment.id,
        created_by: state.user.id,
        created_at: payment.created_at,
      });
      localLog(db, state.user.id, "payment_add", "payment", payment.id, payer.name + ": " + cents);
      saveDb(db);
      return Promise.resolve({ id: payment.id });
    },
    closeCollection: function (id) {
      var db = loadDb();
      db.collections.forEach(function (c) {
        if (c.id === id) c.closed = 1;
      });
      localLog(db, state.user.id, "collection_close", "collection", id, null);
      saveDb(db);
      return Promise.resolve({ ok: true });
    },
    treasury: function () {
      var db = loadDb();
      var items = db.treasury.map(function (t) {
        var author = db.users.find(function (u) { return u.id === t.created_by; });
        return Object.assign({}, t, { author_name: author ? author.name : "" });
      });
      var balance = items.reduce(function (sum, row) {
        return sum + (row.kind === "income" ? row.amount_cents : -row.amount_cents);
      }, 0);
      return Promise.resolve({ items: items, balance_cents: balance });
    },
    addTreasury: function (body) {
      var db = loadDb();
      var cents = toCents(body.amount);
      var title = String(body.title || "").trim();
      if (!title || !cents) return Promise.reject(new Error("invalid_treasury"));
      var item = {
        id: uid(),
        kind: body.kind === "expense" ? "expense" : "income",
        title: title,
        amount_cents: cents,
        receipt_url: String(body.receipt_url || "").trim(),
        payment_id: null,
        created_by: state.user.id,
        created_at: now(),
      };
      db.treasury.unshift(item);
      localLog(db, state.user.id, "treasury_add", "treasury", item.id, item.kind + " " + title);
      saveDb(db);
      return Promise.resolve({ id: item.id });
    },
    documents: function () {
      var db = loadDb();
      return Promise.resolve({
        documents: db.documents.map(function (d) {
          var author = db.users.find(function (u) { return u.id === d.created_by; });
          return Object.assign({}, d, { author_name: author ? author.name : "" });
        }),
      });
    },
    createDocument: function (body) {
      var db = loadDb();
      var title = String(body.title || "").trim();
      if (!title) return Promise.reject(new Error("invalid_document"));
      var item = {
        id: uid(),
        title: title,
        description: String(body.description || "").trim(),
        url: String(body.url || "").trim(),
        body: String(body.body || "").trim(),
        created_by: state.user.id,
        created_at: now(),
      };
      db.documents.unshift(item);
      localLog(db, state.user.id, "document_create", "document", item.id, title);
      saveDb(db);
      return Promise.resolve({ id: item.id });
    },
    deleteDocument: function (id) {
      var db = loadDb();
      db.documents = db.documents.filter(function (d) { return d.id !== id; });
      localLog(db, state.user.id, "document_delete", "document", id, null);
      saveDb(db);
      return Promise.resolve({ ok: true });
    },
    log: function () {
      return Promise.resolve({ items: loadDb().audit_log.slice(0, 100) });
    },
  };

  function remote(path, options) {
    return fetch("/api/" + path, Object.assign({ credentials: "same-origin" }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 503 && data.local) {
          var err = new Error("db_unavailable");
          err.local = true;
          throw err;
        }
        if (!res.ok) throw new Error(data.error || "request_failed");
        return data;
      });
    });
  }

  var useLocal = false;

  function api(name, remoteFn, localFn) {
    if (useLocal) return localFn();
    return remoteFn().catch(function (err) {
      if (err && err.local) {
        useLocal = true;
        state.local = true;
        return localFn();
      }
      throw err;
    });
  }

  var client = {
    session: function () {
      return api("session", function () { return remote("session"); }, localApi.session).then(function (data) {
        state.local = useLocal || data.db === false;
        return data;
      });
    },
    setup: function (body) {
      return api("setup", function () {
        return remote("setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      }, function () { return localApi.setup(body); });
    },
    join: function (body) {
      return api("join", function () {
        return remote("join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      }, function () { return localApi.join(body); });
    },
    login: function (body) {
      return api("login", function () {
        return remote("login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      }, function () { return localApi.login(body); });
    },
    logout: function () {
      return api("logout", function () { return remote("logout", { method: "POST" }); }, localApi.logout);
    },
    members: function () {
      return api("members", function () { return remote("members"); }, localApi.members);
    },
    createInvite: function (body) {
      return api("invites", function () {
        return remote("invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      }, function () { return localApi.createInvite(body); });
    },
    invites: function () {
      return api("invites", function () { return remote("invites"); }, localApi.invites);
    },
    announcements: function () {
      return api("announcements", function () { return remote("announcements"); }, localApi.announcements);
    },
    createAnnouncement: function (body) {
      return api("announcements", function () {
        return remote("announcements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      }, function () { return localApi.createAnnouncement(body); });
    },
    deleteAnnouncement: function (id) {
      return api("announcements", function () { return remote("announcements/" + id, { method: "DELETE" }); }, function () { return localApi.deleteAnnouncement(id); });
    },
    collections: function () {
      return api("collections", function () { return remote("collections"); }, localApi.collections);
    },
    createCollection: function (body) {
      return api("collections", function () {
        return remote("collections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      }, function () { return localApi.createCollection(body); });
    },
    addPayment: function (id, body) {
      return api("payments", function () {
        return remote("collections/" + id + "/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      }, function () { return localApi.addPayment(id, body); });
    },
    closeCollection: function (id) {
      return api("close", function () { return remote("collections/" + id + "/close", { method: "POST" }); }, function () { return localApi.closeCollection(id); });
    },
    treasury: function () {
      return api("treasury", function () { return remote("treasury"); }, localApi.treasury);
    },
    addTreasury: function (body) {
      return api("treasury", function () {
        return remote("treasury", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      }, function () { return localApi.addTreasury(body); });
    },
    documents: function () {
      return api("documents", function () { return remote("documents"); }, localApi.documents);
    },
    createDocument: function (body) {
      return api("documents", function () {
        return remote("documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      }, function () { return localApi.createDocument(body); });
    },
    deleteDocument: function (id) {
      return api("documents", function () { return remote("documents/" + id, { method: "DELETE" }); }, function () { return localApi.deleteDocument(id); });
    },
    log: function () {
      return api("log", function () { return remote("log"); }, localApi.log);
    },
  };

  function banner() {
    if (!state.local) return "";
    return '<p class="banner">Сейчас данные хранятся в этом браузере. Когда в Cloudflare Pages будет подключена D1 с именем <b>DB</b>, комитет станет общим для всех родителей.</p>';
  }

  function codeNotice() {
    if (!state.lastCode) return "";
    return (
      '<div class="panel" style="margin-bottom:16px">' +
      "<p class=\"k\">Сохраните личный код входа</p>" +
      '<p class="code-box">' + esc(state.lastCode) + "</p>" +
      "<p class=\"note\">Код больше не покажем. Им входят председатель и родители.</p>" +
      "</div>"
    );
  }

  function renderAuth() {
    nav.hidden = true;
    who.innerHTML = "";
    view.innerHTML =
      "<h1>Вход в комитет</h1>" +
      banner() +
      (state.needsSetup
        ? '<p class="note">Первый вход создаёт председателя. Дальше остальные заходят по приглашению.</p>' +
          '<form class="form" id="setup-form">' +
          '<label>Ваше имя<input name="name" required minlength="2" autocomplete="name"></label>' +
          '<div class="form-row"><label>Имя ребёнка<input name="child_name"></label><label>Группа / класс<input name="group_name"></label></div>' +
          '<button type="submit">Создать комитет</button><p class="error" data-error></p></form>'
        : "") +
      '<form class="form" id="login-form">' +
      "<h2>Есть код входа</h2>" +
      '<label>Личный код<input name="code" required autocomplete="one-time-code" placeholder="ABCD-EFGH"></label>' +
      '<button type="submit">Войти</button><p class="error" data-error></p></form>' +
      '<form class="form" id="join-form">' +
      "<h2>Приглашение</h2>" +
      '<label>Код приглашения<input name="code" required placeholder="ABCD-EFGH"></label>' +
      '<label>Ваше имя<input name="name" required minlength="2"></label>' +
      '<div class="form-row"><label>Имя ребёнка<input name="child_name"></label><label>Группа / класс<input name="group_name"></label></div>' +
      '<button class="ghost" type="submit">Присоединиться</button><p class="error" data-error></p></form>';

    bindForm("setup-form", function (data) {
      return client.setup(data).then(afterAuth);
    });
    bindForm("login-form", function (data) {
      return client.login(data).then(afterAuth);
    });
    bindForm("join-form", function (data) {
      return client.join(data).then(afterAuth);
    });
  }

  function afterAuth(data) {
    state.user = data.user;
    state.lastCode = data.login_code || "";
    state.needsSetup = false;
    return render();
  }

  function bindForm(id, handler) {
    var form = document.getElementById(id);
    if (!form) return;
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var err = form.querySelector("[data-error]");
      err.textContent = "";
      var data = Object.fromEntries(new FormData(form).entries());
      handler(data).catch(function (error) {
        err.textContent = messageFor(error);
      });
    });
  }

  function messageFor(error) {
    var map = {
      invalid_code: "Код не найден.",
      invite_not_found: "Приглашение уже использовано или его нет.",
      name_required: "Укажите имя.",
      already_setup: "Комитет уже создан. Войдите по коду.",
      forbidden: "Недостаточно прав.",
      unauthorized: "Нужно войти заново.",
    };
    return map[error.message] || "Не получилось сохранить. Проверьте поля.";
  }

  function statusLabel(status) {
    return status === "paid" ? "сдано" : status === "partial" ? "частично" : "не сдано";
  }

  function progressBar(paid, need, people) {
    var pct = need ? Math.min(100, Math.round((paid / (need * Math.max(people, 1))) * 100)) : 0;
    return '<div class="progress" aria-hidden="true"><span style="width:' + pct + '%"></span></div>';
  }

  function renderDashboard(data) {
    var open = data.collections.filter(function (c) { return !c.closed; });
    var news = data.announcements.slice(0, 3);
    view.innerHTML =
      "<h1>Комитет</h1>" +
      banner() +
      codeNotice() +
      '<div class="grid">' +
      '<section class="panel"><p class="k">Касса</p><p class="v">' + esc(rub(data.treasury.balance_cents)) + "</p></section>" +
      '<section class="panel"><p class="k">Открытые сборы</p><p class="v">' + open.length + "</p></section>" +
      '<section class="panel"><p class="k">Участники</p><p class="v">' + data.members.length + "</p></section>" +
      "</div>" +
      "<h2>Сборы</h2>" +
      renderCollectionList(open.length ? open : data.collections.slice(0, 3)) +
      "<h2>Объявления</h2>" +
      (news.length
        ? '<div class="list">' +
          news
            .map(function (a) {
              return '<article class="item"><h3>' + esc(a.title) + "</h3><p class=\"muted\">" + esc(a.body) + "</p></article>";
            })
            .join("") +
          "</div>"
        : '<p class="note">Пока нет объявлений.</p>');
    state.lastCode = "";
  }

  function renderCollectionList(items) {
    if (!items.length) return '<p class="note">Сборов ещё нет.</p>';
    return (
      '<div class="list">' +
      items
        .map(function (c) {
          var need = c.amount_cents * Math.max(c.members.length, 1);
          return (
            '<article class="item">' +
            '<div class="row"><h3>' +
            esc(c.title) +
            "</h3><span class=\"badge " +
            (c.closed ? "role" : "partial") +
            '">' +
            (c.closed ? "закрыт" : "открыт") +
            "</span></div>" +
            '<p class="muted">По ' +
            esc(rub(c.amount_cents)) +
            (c.due_date ? " · до " + esc(c.due_date) : "") +
            " · собрано " +
            esc(rub(c.total_paid_cents)) +
            "</p>" +
            progressBar(c.total_paid_cents, c.amount_cents, c.members.length) +
            "</article>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderSbor(data) {
    view.innerHTML =
      " <h1>Сборы</h1>" +
      banner() +
      (canMoney(state.user)
        ? '<form class="form" id="sbor-form"><h2>Новый сбор</h2>' +
          '<label>Название<input name="title" required placeholder="Новый год"></label>' +
          '<div class="form-row"><label>Сумма с человека, ₽<input name="amount" type="number" min="1" step="0.01" required></label><label>Срок<input name="due_date" type="date"></label></div>' +
          '<label>Зачем<textarea name="description" placeholder="Подарки, оформление, чай"></textarea></label>' +
          '<button type="submit">Открыть сбор</button><p class="error" data-error></p></form>'
        : "") +
      data.collections
        .map(function (c) {
          return (
            '<section class="stack" style="margin-top:18px"><article class="item">' +
            "<h2>" +
            esc(c.title) +
            (c.closed ? ' <span class="badge role">закрыт</span>' : "") +
            "</h2>" +
            '<p class="muted">' +
            esc(c.description || "") +
            " · " +
            esc(rub(c.amount_cents)) +
            " с человека · собрано " +
            esc(rub(c.total_paid_cents)) +
            "</p>" +
            progressBar(c.total_paid_cents, c.amount_cents, c.members.length) +
            '<div class="list" style="margin-top:12px">' +
            c.members
              .map(function (m) {
                return (
                  '<div class="item"><div class="row"><div><strong>' +
                  esc(m.name) +
                  "</strong><div class=\"muted\">" +
                  esc(m.child_name || ROLE[m.role] || "") +
                  "</div></div><span class=\"badge " +
                  m.status +
                  '">' +
                  statusLabel(m.status) +
                  " · " +
                  esc(rub(m.paid_cents)) +
                  "</span></div>" +
                  (canMoney(state.user) && !c.closed
                    ? '<form class="form" data-pay="' +
                      esc(c.id) +
                      '" style="margin:10px 0 0"><input type="hidden" name="user_id" value="' +
                      esc(m.id) +
                      '"><div class="form-row"><label>Сумма, ₽<input name="amount" type="number" min="1" step="0.01" value="' +
                      (c.amount_cents / 100) +
                      '"></label><button type="submit">Отметить</button></div><p class="error" data-error></p></form>'
                    : "") +
                  "</div>"
                );
              })
              .join("") +
            "</div>" +
            (canMoney(state.user) && !c.closed
              ? '<p><button class="ghost" data-close="' + esc(c.id) + '">Закрыть сбор</button></p>'
              : "") +
            "</article></section>"
          );
        })
        .join("") || '<p class="note">Сборов ещё нет.</p>';

    bindForm("sbor-form", function (data) {
      return client.createCollection(data).then(render);
    });
    Array.prototype.forEach.call(view.querySelectorAll("[data-pay]"), function (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var err = form.querySelector("[data-error]");
        err.textContent = "";
        var payload = Object.fromEntries(new FormData(form).entries());
        client.addPayment(form.getAttribute("data-pay"), payload).then(render).catch(function (error) {
          err.textContent = messageFor(error);
        });
      });
    });
    Array.prototype.forEach.call(view.querySelectorAll("[data-close]"), function (btn) {
      btn.addEventListener("click", function () {
        client.closeCollection(btn.getAttribute("data-close")).then(render);
      });
    });
  }

  function renderKassa(data) {
    view.innerHTML =
      " <h1>Касса</h1>" +
      banner() +
      '<section class="panel"><p class="k">Остаток</p><p class="v">' +
      esc(rub(data.balance_cents)) +
      "</p></section>" +
      (canMoney(state.user)
        ? '<form class="form" id="kassa-form"><h2>Операция</h2>' +
          '<div class="form-row"><label>Тип<select name="kind"><option value="income">Приход</option><option value="expense">Расход</option></select></label><label>Сумма, ₽<input name="amount" type="number" min="1" step="0.01" required></label></div>' +
          '<label>Назначение<input name="title" required placeholder="Гирлянды, чай, подарки"></label>' +
          '<label>Ссылка на чек<input name="receipt_url" type="url" placeholder="https://"></label>' +
          '<button type="submit">Записать</button><p class="error" data-error></p></form>'
        : "") +
      (data.items.length
        ? '<div class="list">' +
          data.items
            .map(function (t) {
              return (
                '<article class="item"><div class="row"><strong>' +
                esc(t.title) +
                "</strong><span>" +
                (t.kind === "income" ? "+" : "−") +
                esc(rub(t.amount_cents)) +
                "</span></div><p class=\"muted\">" +
                (t.kind === "income" ? "приход" : "расход") +
                " · " +
                esc(t.author_name || "") +
                " · " +
                esc(when(t.created_at)) +
                (t.receipt_url ? ' · <a href="' + esc(t.receipt_url) + '" target="_blank" rel="noopener">чек</a>' : "") +
                "</p></article>"
              );
            })
            .join("") +
          "</div>"
        : '<p class="note">Операций пока нет.</p>');
    bindForm("kassa-form", function (data) {
      return client.addTreasury(data).then(render);
    });
  }

  function renderNews(data) {
    view.innerHTML =
      " <h1>Объявления</h1>" +
      banner() +
      (canPublish(state.user)
        ? '<form class="form" id="news-form"><label>Заголовок<input name="title" required></label><label>Текст<textarea name="body" required></textarea></label><button type="submit">Опубликовать</button><p class="error" data-error></p></form>'
        : "") +
      (data.announcements.length
        ? '<div class="list">' +
          data.announcements
            .map(function (a) {
              return (
                '<article class="item"><div class="row"><h3>' +
                esc(a.title) +
                "</h3>" +
                (canPublish(state.user) ? '<button class="danger" data-del="' + esc(a.id) + '">Удалить</button>' : "") +
                "</div><p>" +
                esc(a.body) +
                '</p><p class="muted">' +
                esc(a.author_name || "") +
                " · " +
                esc(when(a.created_at)) +
                "</p></article>"
              );
            })
            .join("") +
          "</div>"
        : '<p class="note">Объявлений нет.</p>');
    bindForm("news-form", function (data) {
      return client.createAnnouncement(data).then(render);
    });
    Array.prototype.forEach.call(view.querySelectorAll("[data-del]"), function (btn) {
      btn.addEventListener("click", function () {
        client.deleteAnnouncement(btn.getAttribute("data-del")).then(render);
      });
    });
  }

  function renderDocs(data) {
    view.innerHTML =
      " <h1>Документы</h1>" +
      banner() +
      (canPublish(state.user)
        ? '<form class="form" id="doc-form"><label>Название<input name="title" required placeholder="Протокол собрания"></label><label>Описание<input name="description"></label><label>Ссылка<input name="url" type="url" placeholder="https://"></label><label>Текст / выписка<textarea name="body"></textarea></label><button type="submit">Добавить</button><p class="error" data-error></p></form>'
        : "") +
      (data.documents.length
        ? '<div class="list">' +
          data.documents
            .map(function (d) {
              return (
                '<article class="item"><div class="row"><h3>' +
                esc(d.title) +
                "</h3>" +
                (canPublish(state.user) ? '<button class="danger" data-del="' + esc(d.id) + '">Удалить</button>' : "") +
                "</div><p class=\"muted\">" +
                esc(d.description || "") +
                "</p>" +
                (d.body ? "<p>" + esc(d.body) + "</p>" : "") +
                (d.url ? '<p><a href="' + esc(d.url) + '" target="_blank" rel="noopener">Открыть файл</a></p>' : "") +
                '<p class="muted">' +
                esc(d.author_name || "") +
                " · " +
                esc(when(d.created_at)) +
                "</p></article>"
              );
            })
            .join("") +
          "</div>"
        : '<p class="note">Документов нет. Можно прикрепить ссылку на диск.</p>');
    bindForm("doc-form", function (data) {
      return client.createDocument(data).then(render);
    });
    Array.prototype.forEach.call(view.querySelectorAll("[data-del]"), function (btn) {
      btn.addEventListener("click", function () {
        client.deleteDocument(btn.getAttribute("data-del")).then(render);
      });
    });
  }

  function renderPeople(data) {
    view.innerHTML =
      " <h1>Участники</h1>" +
      banner() +
      codeNotice() +
      (canInvite(state.user)
        ? '<form class="form" id="invite-form"><h2>Пригласить</h2><label>Роль<select name="role"><option value="parent">Родитель</option><option value="member">Член комитета</option><option value="treasurer">Казначей</option><option value="admin">Председатель</option></select></label><button type="submit">Выдать код</button><p class="error" data-error></p></form>' +
          (data.inviteCode ? '<div class="panel"><p class="k">Код приглашения — отправьте в Telegram</p><p class="code-box">' + esc(data.inviteCode) + "</p></div>" : "") +
          '<div class="list" style="margin-bottom:16px">' +
          data.invites
            .map(function (i) {
              return (
                '<article class="item"><div class="row"><span>…' +
                esc(i.code_hint) +
                " · " +
                esc(ROLE[i.role] || i.role) +
                "</span><span class=\"muted\">" +
                (i.used_at ? "использован" : "ждёт") +
                "</span></div></article>"
              );
            })
            .join("") +
          "</div>"
        : "") +
      '<div class="list">' +
      data.members
        .map(function (m) {
          return (
            '<article class="item"><div class="row"><div><strong>' +
            esc(m.name) +
            '</strong><div class="muted">' +
            esc([m.child_name, m.group_name].filter(Boolean).join(" · ")) +
            '</div></div><span class="badge role">' +
            esc(ROLE[m.role] || m.role) +
            "</span></div></article>"
          );
        })
        .join("") +
      "</div>";
    bindForm("invite-form", function (payload) {
      return client.createInvite(payload).then(function (res) {
        state.flash = res.code;
        return render();
      });
    });
    state.lastCode = "";
  }

  var ACTION = {
    setup: "Создан комитет",
    join: "Новый участник",
    login: "Вход",
    invite_create: "Приглашение",
    announce_create: "Объявление",
    announce_delete: "Удалено объявление",
    collection_create: "Открыт сбор",
    collection_close: "Закрыт сбор",
    payment_add: "Платёж по сбору",
    treasury_add: "Операция кассы",
    document_create: "Документ",
    document_delete: "Удалён документ",
  };

  function renderLog(data) {
    view.innerHTML =
      " <h1>Журнал</h1>" +
      banner() +
      (data.items.length
        ? '<div class="list">' +
          data.items
            .map(function (item) {
              return (
                '<article class="item"><div class="row"><strong>' +
                esc(ACTION[item.action] || item.action) +
                '</strong><span class="muted">' +
                esc(when(item.created_at)) +
                "</span></div><p class=\"muted\">" +
                esc(item.actor_name || "") +
                (item.details ? " · " + esc(item.details) : "") +
                "</p></article>"
              );
            })
            .join("") +
          "</div>"
        : '<p class="note">Пока пусто.</p>');
  }

  function setNav() {
    nav.hidden = !state.user;
    var current = route();
    Array.prototype.forEach.call(nav.querySelectorAll("a"), function (link) {
      var name = (link.getAttribute("href") || "").replace("#", "");
      link.classList.toggle("active", name === current);
      if (name === "log") link.hidden = !canLog(state.user);
    });
    who.innerHTML = state.user
      ? esc(state.user.name) + " · " + esc(ROLE[state.user.role] || "") + ' <button class="ghost" id="logout" type="button">Выйти</button>'
      : "";
    var logout = document.getElementById("logout");
    if (logout) {
      logout.addEventListener("click", function () {
        client.logout().then(function () {
          state.user = null;
          render();
        });
      });
    }
  }

  function render() {
    setNav();
    if (!state.user) {
      renderAuth();
      return Promise.resolve();
    }
    var page = route();
    view.innerHTML = '<p class="muted">Загрузка…</p>';
    if (page === "dashboard") {
      return Promise.all([client.collections(), client.announcements(), client.treasury(), client.members()]).then(function (all) {
        renderDashboard({
          collections: all[0].collections || [],
          announcements: all[1].announcements || [],
          treasury: all[2],
          members: all[3].members || [],
        });
      });
    }
    if (page === "sbor") return client.collections().then(function (data) { renderSbor(data); });
    if (page === "kassa") return client.treasury().then(renderKassa);
    if (page === "news") return client.announcements().then(renderNews);
    if (page === "docs") return client.documents().then(renderDocs);
    if (page === "people") {
      return Promise.all([client.members(), canInvite(state.user) ? client.invites() : Promise.resolve({ invites: [] })]).then(function (all) {
        renderPeople({ members: all[0].members || [], invites: all[1].invites || [], inviteCode: state.flash || "" });
        state.flash = "";
      });
    }
    if (page === "log") {
      if (!canLog(state.user)) {
        location.hash = "dashboard";
        return render();
      }
      return client.log().then(renderLog);
    }
    return Promise.resolve();
  }

  window.addEventListener("hashchange", function () {
    render().catch(function (error) {
      view.innerHTML = '<p class="error">' + esc(messageFor(error)) + "</p>";
    });
  });

  client
    .session()
    .then(function (data) {
      state.user = data.user;
      state.needsSetup = !!data.needs_setup;
      state.local = !data.db || useLocal;
      return render();
    })
    .catch(function () {
      useLocal = true;
      state.local = true;
      return localApi.session().then(function (data) {
        state.user = data.user;
        state.needsSetup = data.needs_setup;
        return render();
      });
    });
})();
