/* ============================================================
   app.js —— 页面逻辑
   表单收集 / 校验 / 本地保存 / 调用后端 / 流式渲染 / 工具栏
   ============================================================ */
(function () {
  'use strict';

  var API = window.StudyPlanAPI;
  var MD = window.MarkdownLite;
  var STORAGE_KEY = 'study-plan-form-v1';

  /* ---------------------------------------------- DOM 引用 */
  function $(id) { return document.getElementById(id); }

  var els = {
    form: $('plan-form'),
    submit: $('btn-submit'),
    submitText: $('btn-submit-text'),
    reset: $('btn-reset'),
    sample: $('btn-sample'),
    thinking: $('thinking'),

    connBadge: $('conn-badge'),
    connText: $('conn-text'),
    modelBadge: $('model-badge'),

    stateEmpty: $('state-empty'),
    stateLoading: $('state-loading'),
    stateError: $('state-error'),
    stateResult: $('state-result'),

    loadingTitle: $('loading-title'),
    loadingStatus: $('loading-status'),
    loadingTimer: $('loading-timer'),
    loadingChars: $('loading-chars'),
    progressBar: $('progress-bar'),
    thinkPanel: $('think-panel'),
    thinkToggle: $('think-toggle'),
    thinkPreview: $('think-preview'),
    thinkBody: $('think-body'),
    abort: $('btn-abort'),

    errorMessage: $('error-message'),
    errorDetail: $('error-detail'),
    retry: $('btn-retry'),
    errorCopy: $('btn-error-copy'),

    planContent: $('plan-content'),
    resultMeta: $('result-meta'),
    copy: $('btn-copy'),
    download: $('btn-download'),
    print: $('btn-print'),
    again: $('btn-again'),

    // 保存相关
    save: $('btn-save'),
    saveText: $('btn-save-text'),
    savedBanner: $('saved-banner'),
    savedBannerText: $('saved-banner-text'),
    backLive: $('btn-back-live'),
    library: $('btn-library'),
    libCount: $('lib-count'),
    drawer: $('drawer'),
    drawerOverlay: $('drawer-overlay'),
    drawerClose: $('btn-drawer-close'),
    drawerCount: $('drawer-count'),
    libSearch: $('lib-search'),
    autoSave: $('auto-save'),
    libList: $('lib-list'),
    libFootText: $('lib-foot-text'),
    exportAll: $('btn-export'),

    toastStack: $('toast-stack')
  };

  var state = {
    controller: null,
    raw: '',
    reasoning: '',
    meta: null,
    errorText: '',
    startedAt: 0,
    timerId: null,
    statusId: null,
    statusIndex: 0,
    renderPending: false,
    lastRender: 0,
    // 保存相关
    profile: null,       // 生成本次计划时提交的学员信息
    savedId: null,       // 当前计划对应的已保存记录 id
    savedAt: '',
    viewingId: null,     // 正在查看的已保存计划的 id
    liveSnapshot: null,  // 「返回本次生成」用
    library: [],
    libraryTotal: 0,
    pendingDelete: null,
    searchTimer: null,
    saving: false
  };

  var AUTOSAVE_KEY = 'study-plan-autosave';

  var STATUS_STEPS = [
    '正在分析你的知识基础…',
    '正在评估你的学习习惯与可支配时间…',
    '正在设计分阶段学习路线…',
    '正在编排每周时间表…',
    '正在撰写每日执行清单…',
    '正在生成检查点与自测机制…',
    '正在整理学习方法与资源建议…'
  ];

  /* ---------------------------------------------- 通用工具 */
  function toast(message, type, duration) {
    if (!els.toastStack) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = message;
    els.toastStack.appendChild(el);
    var ttl = duration || (type === 'err' ? 5200 : 3000);
    setTimeout(function () {
      el.classList.add('hide');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    }, ttl);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(ta);
      }
    });
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function timestamp() {
    var d = new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '_' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  /* ---------------------------------------------- 状态切换 */
  function showState(name) {
    [['empty', els.stateEmpty], ['loading', els.stateLoading],
     ['error', els.stateError], ['result', els.stateResult]].forEach(function (pair) {
      if (pair[1]) pair[1].hidden = (pair[0] !== name);
    });
  }

  /* ---------------------------------------------- 表单读写 */
  function collectForm() {
    var gender = '';
    var checked = els.form.querySelector('input[name="gender"]:checked');
    if (checked) gender = checked.value;

    return {
      name: ($('name').value || '').trim(),
      gender: gender,
      age: ($('age').value || '').trim(),
      education: ($('education').value || '').trim(),
      knowledge_base: ($('knowledge_base').value || '').trim(),
      study_habit: ($('study_habit').value || '').trim(),
      goal: ($('goal').value || '').trim(),
      weekly_hours: ($('weekly_hours').value || '').trim(),
      duration: ($('duration').value || '').trim(),
      preference: ($('preference').value || '').trim(),
      thinking: els.thinking.checked
    };
  }

  function fillForm(data) {
    ['name', 'age', 'education', 'knowledge_base', 'study_habit',
     'goal', 'weekly_hours', 'duration', 'preference'].forEach(function (key) {
      var el = $(key);
      if (el && data[key] !== undefined && data[key] !== null) el.value = data[key];
    });
    if (data.gender) {
      var radio = els.form.querySelector('input[name="gender"][value="' + data.gender + '"]');
      if (radio) radio.checked = true;
    }
    if (typeof data.thinking === 'boolean') els.thinking.checked = data.thinking;
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collectForm()));
    } catch (e) { /* 隐私模式下可能失败，忽略 */ }
  }

  function restore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        fillForm(data);
        if (data.goal || data.weekly_hours || data.duration || data.preference) {
          $('advanced').open = true;
        }
      }
    } catch (e) { /* 忽略损坏的缓存 */ }
  }

  /* ---------------------------------------------- 校验 */
  function clearErrors() {
    Array.prototype.forEach.call(document.querySelectorAll('.field-error'), function (el) {
      el.textContent = '';
      el.classList.remove('show');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.input.invalid'), function (el) {
      el.classList.remove('invalid');
    });
  }

  function setError(field, message) {
    var box = document.querySelector('[data-error-for="' + field + '"]');
    if (box) {
      box.textContent = message;
      box.classList.add('show');
    }
    var input = $(field);
    if (input && input.classList.contains('input')) input.classList.add('invalid');
  }

  function validate(data) {
    var errors = {};
    if (!data.name) errors.name = '请填写姓名';
    if (!data.gender) errors.gender = '请选择性别';
    if (!data.age) {
      errors.age = '请填写年龄';
    } else {
      var age = Number(data.age);
      if (isNaN(age) || age < 5 || age > 100) errors.age = '年龄请填写 5 - 100 之间的数字';
    }
    if (!data.education) errors.education = '请选择学历';
    if (!data.knowledge_base) {
      errors.knowledge_base = '请描述你的知识基础';
    } else if (data.knowledge_base.length < 4) {
      errors.knowledge_base = '描述太短了，请再具体一些';
    }
    if (!data.study_habit) {
      errors.study_habit = '请描述你的学习习惯';
    } else if (data.study_habit.length < 4) {
      errors.study_habit = '描述太短了，请再具体一些';
    }
    return errors;
  }

  /* ---------------------------------------------- 渲染 */
  function renderPlan() {
    if (!els.planContent) return;
    els.planContent.innerHTML = MD.render(state.raw);
  }

  function scheduleRender(force) {
    var now = Date.now();
    if (!force && now - state.lastRender < 120) return;
    state.lastRender = now;
    renderPlan();
  }

  function updateMeta(meta) {
    state.meta = meta || {};
    var parts = [];
    if (state.meta.elapsed) parts.push('用时 ' + state.meta.elapsed + 's');
    parts.push('正文 ' + state.raw.length + ' 字');
    if (state.meta.usage && state.meta.usage.completion_tokens) {
      parts.push('输出 ' + state.meta.usage.completion_tokens + ' tokens');
    }
    if (state.meta.model_alias || state.meta.model) {
      parts.push(state.meta.model_alias || state.meta.model);
    }
    if (els.resultMeta) els.resultMeta.textContent = parts.join(' · ');
  }

  /* ---------------------------------------------- 加载态控制 */
  function startLoadingUi(thinking) {
    state.statusIndex = 0;
    if (els.loadingStatus) els.loadingStatus.textContent = STATUS_STEPS[0];
    if (els.loadingTimer) els.loadingTimer.textContent = '已用时 0.0s';
    if (els.loadingChars) els.loadingChars.textContent = '已生成 0 字';
    if (els.progressBar) els.progressBar.style.width = '2%';
    if (els.loadingTitle) els.loadingTitle.textContent = '正在为你生成学习计划…';

    if (els.thinkPanel) {
      els.thinkPanel.hidden = !thinking;
      els.thinkBody.hidden = true;
      els.thinkBody.textContent = '';
      els.thinkPreview.textContent = '正在推理…';
      els.thinkToggle.setAttribute('aria-expanded', 'false');
    }

    if (els.submit) {
      els.submit.disabled = true;
      els.submitText.textContent = '生成中…';
      var spin = document.createElement('span');
      spin.className = 'spin';
      els.submit.insertBefore(spin, els.submit.firstChild);
      els.submit.dataset.spin = '1';
    }

    state.startedAt = Date.now();
    state.timerId = setInterval(function () {
      var sec = (Date.now() - state.startedAt) / 1000;
      if (els.loadingTimer) els.loadingTimer.textContent = '已用时 ' + sec.toFixed(1) + 's';
      if (els.loadingChars) els.loadingChars.textContent = '已生成 ' + state.raw.length + ' 字';
      // 进度条：随时间渐进，最多到 95%，真正完成时再拉满
      var pct = 95 * (1 - Math.exp(-sec / 22));
      if (els.progressBar && pct > parseFloat(els.progressBar.style.width || '0')) {
        els.progressBar.style.width = pct.toFixed(1) + '%';
      }
    }, 100);

    state.statusIndex = 0;
    state.statusId = setInterval(function () {
      state.statusIndex = (state.statusIndex + 1) % STATUS_STEPS.length;
      if (els.loadingStatus) els.loadingStatus.textContent = STATUS_STEPS[state.statusIndex];
    }, 2800);
  }

  function stopLoadingUi() {
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
    if (state.statusId) { clearInterval(state.statusId); state.statusId = null; }
    if (els.submit) {
      els.submit.disabled = false;
      els.submitText.textContent = '生成我的学习计划';
      var spin = els.submit.querySelector('.spin');
      if (spin && spin.parentNode) spin.parentNode.removeChild(spin);
      delete els.submit.dataset.spin;
    }
    if (els.planContent) els.planContent.classList.remove('typing-cursor');
  }

  /* ---------------------------------------------- 主流程 */
  function buildPayload(data) {
    return {
      name: data.name,
      gender: data.gender,
      age: Number(data.age),
      education: data.education,
      knowledge_base: data.knowledge_base,
      study_habit: data.study_habit,
      goal: data.goal,
      weekly_hours: data.weekly_hours,
      duration: data.duration,
      preference: data.preference,
      thinking: !!data.thinking,
      reasoning_effort: 'high'
    };
  }

  function showError(message, detail) {
    state.errorText = detail ? (message + '\n\n' + detail) : message;
    if (els.errorMessage) els.errorMessage.textContent = message;
    if (els.errorDetail) {
      els.errorDetail.textContent = detail || '';
      els.errorDetail.hidden = !detail;
    }
    showState('error');
  }

  function finishWithResult(meta, completed) {
    stopLoadingUi();
    updateMeta(meta);
    scheduleRender(true);
    if (els.planContent) els.planContent.classList.remove('typing-cursor');
    showState('result');
    updateSaveButton();
    toast('学习计划已生成', 'ok');
    // 自动保存：只在完整生成结束后触发（手动停止的半成品不自动存）
    if (completed && els.autoSave && els.autoSave.checked && state.raw) {
      saveCurrentPlan(true);
    }
  }

  function generate() {
    if (state.controller) return;   // 正在生成中

    var data = collectForm();
    clearErrors();

    var errors = validate(data);
    if (Object.keys(errors).length) {
      Object.keys(errors).forEach(function (k) { setError(k, errors[k]); });
      var first = document.querySelector('.input.invalid, .field-error.show');
      if (first && first.scrollIntoView) {
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      toast('请先补全带 * 的必填信息', 'warn');
      return;
    }

    persist();
    state.raw = '';
    state.reasoning = '';
    state.meta = null;
    state.lastRender = 0;
    // 新一轮生成：清掉上一份的保存/查看状态
    state.profile = data;
    state.savedId = null;
    state.savedAt = '';
    state.viewingId = null;
    state.saving = false;
    if (els.savedBanner) els.savedBanner.hidden = true;
    if (els.backLive) els.backLive.hidden = true;
    updateSaveButton();

    var payload = buildPayload(data);
    state.controller = new AbortController();

    showState('loading');
    startLoadingUi(payload.thinking);
    if (els.planContent) {
      els.planContent.innerHTML = '';
      els.planContent.classList.add('typing-cursor');
    }

    streamGenerate(payload).catch(function (err) {
      var info = API.normalizeError(err);

      if (info.canceled) {
        stopLoadingUi();
        state.controller = null;
        if (state.raw) {
          finishWithResult({ note: '已手动停止，以下是已生成的部分内容' }, false);
          toast('已停止生成，保留了已完成的部分', 'warn');
        } else {
          showState('empty');
          toast('已停止生成', 'warn');
        }
        return;
      }

      if (info.fields) {
        Object.keys(info.fields).forEach(function (k) { setError(k, info.fields[k]); });
      }

      // 流式失败且没有任何内容 -> 自动回退到非流式接口
      if (!state.raw) {
        toast('流式通道不可用，正在改用普通模式重试…', 'warn');
        normalGenerate(payload).catch(function (err2) {
          var info2 = API.normalizeError(err2);
          stopLoadingUi();
          state.controller = null;
          if (info2.fields) {
            Object.keys(info2.fields).forEach(function (k) { setError(k, info2.fields[k]); });
          }
          showError(info2.message, info2.detail || '');
          toast('生成失败：' + info2.message, 'err');
        });
        return;
      }

      stopLoadingUi();
      state.controller = null;
      showError(info.message, info.detail || '（已生成的内容未能完整返回）');
      toast('生成中断：' + info.message, 'err');
    });
  }

  function streamGenerate(payload) {
    return API.createPlanStream(payload, {
      start: function (data) {
        if (els.loadingTitle) {
          els.loadingTitle.textContent = '正在为「' + (data.student || '你') + '」生成学习计划…';
        }
      },
      reasoning: function (data) {
        var delta = data.delta || '';
        if (!delta) return;
        state.reasoning += delta;
        if (els.thinkBody) {
          els.thinkBody.textContent = state.reasoning;
          if (els.thinkToggle.getAttribute('aria-expanded') === 'true') {
            els.thinkBody.scrollTop = els.thinkBody.scrollHeight;
          }
        }
        if (els.thinkPreview) {
          var preview = state.reasoning.replace(/\s+/g, ' ').slice(-46);
          els.thinkPreview.textContent = preview;
        }
      },
      content: function (data) {
        var delta = data.delta || '';
        if (!delta) return;
        state.raw += delta;
        scheduleRender(false);
      },
      finish: function () { scheduleRender(true); },
      done: function (data) {
        finishWithResult(data, true);
        state.controller = null;
      },
      error: function () {
        /* 由 api.js 统一转成 Promise 拒绝，这里无需处理 */
      }
    }, { signal: state.controller.signal });
  }

  function normalGenerate(payload) {
    return API.createPlan(payload, { signal: state.controller.signal })
      .then(function (data) {
        if (!data || !data.ok || !data.plan) {
          throw new Error((data && data.error) || '返回数据异常');
        }
        state.raw = data.plan;
        state.reasoning = data.reasoning || '';
        finishWithResult(data.meta || {}, true);
        state.controller = null;
        return data;
      });
  }

  /* ============================================================
     保存计划 / 我的计划
     ============================================================ */

  function updateSaveButton() {
    if (!els.save) return;
    var saved = !!state.viewingId || !!state.savedId;
    els.save.disabled = !state.raw || saved || state.saving;
    els.save.classList.toggle('is-saved', saved);
    els.save.classList.toggle('saving', state.saving);
    els.saveText.textContent = saved ? '已保存' : (state.saving ? '保存中…' : '保存计划');
    els.save.title = saved
      ? '这份计划已保存在「我的计划」中'
      : '保存到服务端数据库，之后可随时查看';
  }

  function setLibCount(n) {
    if (els.libCount) {
      els.libCount.textContent = String(n);
      els.libCount.hidden = !n;
    }
    if (els.drawerCount) els.drawerCount.textContent = String(n);
  }

  /** 保存当前生成的计划（silent = 自动保存时静默提示） */
  function saveCurrentPlan(silent) {
    if (!state.raw || state.viewingId || state.savedId || state.saving) {
      return Promise.resolve(null);
    }

    state.saving = true;
    updateSaveButton();

    var payload = {};
    var source = state.profile || {};
    Object.keys(source).forEach(function (k) { payload[k] = source[k]; });
    payload.plan = state.raw;
    payload.reasoning = state.reasoning || '';
    payload.meta = state.meta || {};

    return API.savePlan(payload).then(function (res) {
      state.saving = false;
      state.savedId = res.id;
      state.savedAt = res.saved_at;
      updateSaveButton();
      setLibCount(res.total);
      loadLibrary(els.libSearch ? els.libSearch.value : '', true);
      toast(res.duplicated ? '这份计划之前已保存过' : (silent ? '已自动保存到「我的计划」' : '计划已保存'), 'ok');
      return res;
    }).catch(function (err) {
      state.saving = false;
      updateSaveButton();
      var info = API.normalizeError(err);
      toast('保存失败：' + info.message, 'err');
      return null;
    });
  }

  /* ---------------------------------------------- 抽屉开关 */
  function openDrawer() {
    if (!els.drawer || !els.drawer.hidden) return;
    els.drawer.hidden = false;
    els.drawerOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
    loadLibrary(els.libSearch ? els.libSearch.value : '', false);
    setTimeout(function () { if (els.libSearch) els.libSearch.focus(); }, 260);
  }

  function closeDrawer() {
    if (!els.drawer || els.drawer.hidden) return;
    els.drawer.hidden = true;
    els.drawerOverlay.hidden = true;
    document.body.style.overflow = '';
  }

  /* ---------------------------------------------- 列表加载与渲染 */
  function loadLibrary(keyword, silent) {
    if (!silent && els.libList && !state.library.length) {
      els.libList.innerHTML = '<div class="skeleton"></div>' +
        '<div class="skeleton"></div><div class="skeleton"></div>';
    }
    return API.listPlans({ keyword: keyword || '', limit: 200 })
      .then(function (data) {
        state.library = data.items || [];
        state.libraryTotal = data.total || 0;
        setLibCount((data.stats && data.stats.total) || state.libraryTotal);
        renderLibrary(keyword);
        return data;
      })
      .catch(function (err) {
        var info = API.normalizeError(err);
        if (els.libList) {
          els.libList.innerHTML = '';
          els.libList.appendChild(libEmpty('加载失败', info.message));
        }
        if (!silent) toast('读取「我的计划」失败：' + info.message, 'err');
        return null;
      });
  }

  function libEmpty(title, desc) {
    var box = document.createElement('div');
    box.className = 'lib-empty';
    box.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3z"/>' +
      '<path d="M9 8h7M9 12h5"/></svg>';
    var h = document.createElement('h3');
    h.textContent = title;
    var p = document.createElement('p');
    p.textContent = desc;
    box.appendChild(h);
    box.appendChild(p);
    return box;
  }

  function chip(text) {
    var i = document.createElement('i');
    i.textContent = text;
    return i;
  }

  function planCard(item) {
    var card = document.createElement('article');
    card.className = 'plan-card' + (state.viewingId === item.id ? ' active' : '');
    card.setAttribute('data-id', item.id);

    // 标题行 + 收藏
    var head = document.createElement('div');
    head.className = 'plan-card-head';

    var title = document.createElement('h3');
    title.className = 'plan-card-title';
    title.textContent = item.title || ((item.name || '学员') + '的学习计划');
    head.appendChild(title);

    var star = document.createElement('button');
    star.type = 'button';
    star.className = 'star-btn';
    star.setAttribute('data-star', item.id);
    star.setAttribute('aria-pressed', item.starred ? 'true' : 'false');
    star.title = item.starred ? '取消收藏' : '收藏（置顶）';
    star.innerHTML = '<svg viewBox="0 0 24 24" fill="' + (item.starred ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">' +
      '<path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/></svg>';
    head.appendChild(star);

    card.appendChild(head);

    // 元信息
    var meta = document.createElement('p');
    meta.className = 'plan-card-meta';
    if (item.education) meta.appendChild(chip(item.education));
    if (item.age) meta.appendChild(chip(item.age + ' 岁'));
    if (item.gender) meta.appendChild(chip(item.gender));
    meta.appendChild(chip((item.char_count || 0) + ' 字'));
    card.appendChild(meta);

    if (item.goal) {
      var goal = document.createElement('p');
      goal.className = 'plan-card-goal';
      goal.textContent = '目标：' + item.goal;
      card.appendChild(goal);
    }

    // 底栏
    var foot = document.createElement('div');
    foot.className = 'plan-card-foot';

    var time = document.createElement('span');
    time.className = 'plan-card-time';
    time.textContent = item.created_at || '';
    foot.appendChild(time);

    var actions = document.createElement('div');
    actions.className = 'plan-card-actions';

    var view = document.createElement('button');
    view.type = 'button';
    view.className = 'btn btn-ghost btn-xs';
    view.setAttribute('data-view', item.id);
    view.textContent = state.viewingId === item.id ? '查看中' : '查看';
    actions.appendChild(view);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost btn-xs btn-danger';
    del.setAttribute('data-del', item.id);
    del.textContent = state.pendingDelete === item.id ? '确认删除' : '删除';
    actions.appendChild(del);

    foot.appendChild(actions);
    card.appendChild(foot);

    return card;
  }

  function renderLibrary(keyword) {
    if (!els.libList) return;
    els.libList.innerHTML = '';

    if (!state.library.length) {
      els.libList.appendChild(keyword
        ? libEmpty('没有找到匹配的计划', '换个关键词试试，比如学员姓名、学历或学习目标。')
        : libEmpty('还没有保存任何计划', '生成一份学习计划后，点结果上方的「保存计划」即可存到这里。'));
    } else {
      state.library.forEach(function (item) {
        els.libList.appendChild(planCard(item));
      });
    }

    if (els.libFootText) {
      els.libFootText.textContent = keyword
        ? '筛选出 ' + state.library.length + ' / ' + state.libraryTotal + ' 份'
        : '共保存 ' + state.libraryTotal + ' 份计划';
    }
    if (els.exportAll) els.exportAll.disabled = !state.library.length;
  }

  /* ---------------------------------------------- 查看 / 收藏 / 删除 */
  function viewSavedPlan(id) {
    return API.getPlan(id).then(function (res) {
      var item = res.item;

      // 首次查看时，把当前生成的内容暂存，方便「返回本次生成」
      if (!state.viewingId && state.raw) {
        state.liveSnapshot = {
          raw: state.raw, reasoning: state.reasoning, meta: state.meta,
          savedId: state.savedId, profile: state.profile
        };
      }

      state.viewingId = item.id;
      state.raw = item.plan_md || '';
      state.reasoning = item.reasoning || '';
      state.meta = {
        model_alias: item.model,
        elapsed: item.elapsed,
        usage: { total_tokens: item.total_tokens }
      };
      state.profile = {
        name: item.name, gender: item.gender, age: item.age, education: item.education,
        knowledge_base: item.knowledge_base, study_habit: item.study_habit, goal: item.goal,
        weekly_hours: item.weekly_hours, duration: item.duration, preference: item.preference
      };

      showState('result');
      if (els.savedBanner) {
        els.savedBanner.hidden = false;
        els.savedBannerText.textContent = '正在查看已保存的计划 · 保存于 ' + item.created_at;
        els.backLive.hidden = !state.liveSnapshot;
      }
      updateMeta(state.meta);
      renderPlan();
      updateSaveButton();
      closeDrawer();
      toast('已打开「' + (item.title || '学习计划') + '」', 'ok');
      return item;
    }).catch(function (err) {
      var info = API.normalizeError(err);
      toast('打开失败：' + info.message, 'err');
      loadLibrary(null, true);
    });
  }

  function restoreLive() {
    if (!state.liveSnapshot) return;
    var snap = state.liveSnapshot;
    state.viewingId = null;
    state.raw = snap.raw;
    state.reasoning = snap.reasoning;
    state.meta = snap.meta;
    state.savedId = snap.savedId;
    state.profile = snap.profile;
    state.liveSnapshot = null;
    if (els.savedBanner) els.savedBanner.hidden = true;
    if (els.backLive) els.backLive.hidden = true;
    updateMeta(state.meta);
    renderPlan();
    updateSaveButton();
  }

  function toggleStar(id, starred) {
    // 先乐观更新界面，失败再回滚
    state.library.forEach(function (it) { if (it.id === id) it.starred = starred; });
    state.library.sort(function (a, b) {
      if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
      return String(b.created_at).localeCompare(String(a.created_at));
    });
    renderLibrary(els.libSearch ? els.libSearch.value : '');

    API.starPlan(id, starred).catch(function (err) {
      var info = API.normalizeError(err);
      state.library.forEach(function (it) { if (it.id === id) it.starred = !starred; });
      renderLibrary(els.libSearch ? els.libSearch.value : '');
      toast('操作失败：' + info.message, 'err');
    });
  }

  function deleteSavedPlan(id) {
    var item = null;
    state.library.forEach(function (it) { if (it.id === id) item = it; });

    return API.deletePlan(id).then(function (res) {
      state.pendingDelete = null;
      if (state.viewingId === id) {
        // 正在看的那份被删了，退回本次生成或空状态
        state.viewingId = null;
        if (els.savedBanner) els.savedBanner.hidden = true;
        if (state.liveSnapshot) restoreLive();
        else { state.raw = ''; showState('empty'); updateSaveButton(); }
      }
      setLibCount(res.total);
      toast('已删除「' + ((item && item.title) || '计划') + '」', 'ok');
      return loadLibrary(els.libSearch ? els.libSearch.value : '', true);
    }).catch(function (err) {
      var info = API.normalizeError(err);
      state.pendingDelete = null;
      toast('删除失败：' + info.message, 'err');
      renderLibrary(els.libSearch ? els.libSearch.value : '');
    });
  }

  function bindLibraryEvents() {
    if (els.library) els.library.addEventListener('click', openDrawer);
    if (els.drawerClose) els.drawerClose.addEventListener('click', closeDrawer);
    if (els.drawerOverlay) els.drawerOverlay.addEventListener('click', closeDrawer);

    if (els.libList) {
      els.libList.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;

        var star = t.closest('[data-star]');
        if (star) {
          toggleStar(star.getAttribute('data-star'),
            star.getAttribute('aria-pressed') !== 'true');
          return;
        }

        var view = t.closest('[data-view]');
        if (view) {
          viewSavedPlan(view.getAttribute('data-view'));
          return;
        }

        var del = t.closest('[data-del]');
        if (del) {
          var id = del.getAttribute('data-del');
          if (state.pendingDelete === id) {
            deleteSavedPlan(id);
          } else {
            state.pendingDelete = id;
            renderLibrary(els.libSearch ? els.libSearch.value : '');
            toast('再点一次「确认删除」即可删除', 'warn');
            setTimeout(function () {
              if (state.pendingDelete === id) {
                state.pendingDelete = null;
                renderLibrary(els.libSearch ? els.libSearch.value : '');
              }
            }, 4000);
          }
        }
      });
    }

    if (els.libSearch) {
      els.libSearch.addEventListener('input', function () {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(function () {
          loadLibrary(els.libSearch.value, true);
        }, 260);
      });
    }

    if (els.autoSave) {
      try { els.autoSave.checked = localStorage.getItem(AUTOSAVE_KEY) === '1'; } catch (e) {}
      els.autoSave.addEventListener('change', function () {
        try { localStorage.setItem(AUTOSAVE_KEY, els.autoSave.checked ? '1' : '0'); } catch (e) {}
        toast(els.autoSave.checked ? '已开启：生成完成后自动保存' : '已关闭自动保存', 'ok');
      });
    }

    if (els.exportAll) {
      els.exportAll.addEventListener('click', function () {
        var a = document.createElement('a');
        a.href = API.exportUrl();
        a.download = 'study-plans.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        toast('正在导出全部计划（JSON）', 'ok');
      });
    }

    if (els.save) els.save.addEventListener('click', function () { saveCurrentPlan(false); });
    if (els.backLive) els.backLive.addEventListener('click', restoreLive);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });
  }

  /* ---------------------------------------------- 事件绑定 */
  function bindFormEvents() {
    // 快捷标签
    Array.prototype.forEach.call(document.querySelectorAll('.chips'), function (group) {
      var target = $(group.getAttribute('data-target'));
      group.addEventListener('click', function (e) {
        var chip = e.target.closest ? e.target.closest('.chip') : null;
        if (!chip || !target) return;
        var text = chip.textContent.trim();
        target.value = target.value.trim() ? (target.value.trim() + '；' + text) : text;
        target.focus();
        target.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });

    els.form.addEventListener('submit', function (e) {
      e.preventDefault();
      generate();
    });

    els.form.addEventListener('input', function (e) {
      var el = e.target;
      if (el && el.classList && el.classList.contains('invalid')) {
        el.classList.remove('invalid');
        var box = document.querySelector('[data-error-for="' + el.id + '"]');
        if (box) { box.textContent = ''; box.classList.remove('show'); }
      }
    });

    els.form.addEventListener('change', function () {
      persist();
    });

    els.reset.addEventListener('click', function () {
      els.form.reset();
      clearErrors();
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      state.raw = '';
      state.reasoning = '';
      showState('empty');
      toast('已重置表单', 'ok');
    });

    els.sample.addEventListener('click', function () {
      fillForm({
        name: '李明',
        gender: '男',
        age: '21',
        education: '本科',
        knowledge_base: '计算机专业大三，Python 会基础语法但没写过完整项目，数据结构与算法基本忘光了，英语能读文档但速度慢。',
        study_habit: '晚上 8-10 点效率最高，每天能学 2 小时，周末每天 3 小时；喜欢看视频课 + 动手写代码，容易刷手机分心。',
        goal: '3 个月后拿到后端开发实习 offer',
        weekly_hours: '15 小时',
        duration: '3 个月',
        preference: '视频课 + 动手做项目，不喜欢看厚书',
        thinking: true
      });
      $('advanced').open = true;
      persist();
      toast('已填入示例数据，可直接点击生成', 'ok');
    });
  }

  function bindLoadingEvents() {
    els.thinkToggle.addEventListener('click', function () {
      var expanded = els.thinkToggle.getAttribute('aria-expanded') === 'true';
      els.thinkToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      els.thinkBody.hidden = expanded;
      if (!expanded) els.thinkBody.scrollTop = els.thinkBody.scrollHeight;
    });

    els.abort.addEventListener('click', function () {
      if (state.controller) {
        state.controller.abort();
        toast('正在停止生成…', 'warn');
      }
    });
  }

  function bindResultEvents() {
    els.copy.addEventListener('click', function () {
      if (!state.raw) return;
      copyText(state.raw).then(function () {
        toast('已复制 Markdown 原文到剪贴板', 'ok');
      }).catch(function () {
        toast('复制失败，请手动选择文本复制', 'err');
      });
    });

    els.download.addEventListener('click', function () {
      if (!state.raw) return;
      var name = ($('name').value || '学员').trim();
      var filename = name + '的学习计划_' + timestamp() + '.md';
      var blob = new Blob([state.raw], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      toast('已开始下载：' + filename, 'ok');
    });

    els.print.addEventListener('click', function () {
      window.print();
    });

    els.again.addEventListener('click', function () {
      generate();
    });

    els.retry.addEventListener('click', function () {
      generate();
    });

    els.errorCopy.addEventListener('click', function () {
      copyText(state.errorText || '')
        .then(function () { toast('错误详情已复制', 'ok'); })
        .catch(function () { toast('复制失败', 'err'); });
    });
  }

  /* ---------------------------------------------- 后端状态检测 */
  function checkHealth() {
    if (!els.connBadge) return;
    API.health().then(function (data) {
      els.connBadge.dataset.state = 'ok';
      els.connText.textContent = '后端已连接';
      if (data && data.model) {
        els.connBadge.title = '模型：' + (data.model_alias || '') + ' / ' + data.model +
          '　接口：' + data.base_url;
      }
      if (data && !data.api_key_configured) {
        els.connBadge.dataset.state = 'error';
        els.connText.textContent = '未配置 API Key';
        toast('后端未配置 DEEPSEEK_API_KEY，请在 .env 中填写后重启服务', 'err', 8000);
      }
    }).catch(function () {
      els.connBadge.dataset.state = 'error';
      els.connText.textContent = '后端未连接';
      els.connBadge.title = '请先运行 python backend/server.py';
      toast('无法连接后端服务，请先启动 python backend/server.py', 'err', 8000);
    });
  }

  /* ---------------------------------------------- 初始化 */
  function init() {
    if (!window.axios) return;               // axios 没加载成功时不继续
    restore();
    bindFormEvents();
    bindLoadingEvents();
    bindResultEvents();
    bindLibraryEvents();
    showState('empty');
    updateSaveButton();
    checkHealth();
    loadLibrary('', true);                   // 拉一次已保存计划，填充顶部数量角标

    document.addEventListener('keydown', function (e) {
      // Ctrl / Cmd + Enter 快捷提交
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        generate();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
