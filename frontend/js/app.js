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
    lastRender: 0
  };

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

  function finishWithResult(meta) {
    stopLoadingUi();
    updateMeta(meta);
    scheduleRender(true);
    if (els.planContent) els.planContent.classList.remove('typing-cursor');
    showState('result');
    toast('学习计划已生成', 'ok');
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
          finishWithResult({ note: '已手动停止，以下是已生成的部分内容' });
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
        finishWithResult(data);
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
        finishWithResult(data.meta || {});
        state.controller = null;
        return data;
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
    showState('empty');
    checkHealth();

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
