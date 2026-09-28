/* ============================================================
   api.js —— 与后端通信（基于 Axios）
   - health()            健康检查
   - createPlan()        非流式生成
   - createPlanStream()  流式生成（SSE，边生成边回调）
   ============================================================ */
(function (global) {
  'use strict';

  // 与后端同源；若前端单独用 Live Server 打开，可改成 'http://127.0.0.1:8000'
  var BASE_URL = '';

  var http = axios.create({
    baseURL: BASE_URL,
    timeout: 0,               // 大模型生成较慢，不设上限，由用户手动取消
    headers: { 'Content-Type': 'application/json' },
    validateStatus: function (status) { return status >= 200 && status < 300; }
  });

  /* -------------------------------------------- 错误归一化 */
  function normalizeError(err) {
    if (axios.isCancel && axios.isCancel(err)) {
      return { canceled: true, message: '已取消生成。', fields: null };
    }
    if (err && err.code === 'ERR_CANCELED') {
      return { canceled: true, message: '已取消生成。', fields: null };
    }

    var res = err && err.response;
    if (res) {
      var data = res.data;
      var message = (data && data.error) || ('请求失败（HTTP ' + res.status + '）');
      return {
        canceled: false,
        message: message,
        fields: (data && data.fields) || null,
        detail: (data && data.detail) || '',
        status: res.status
      };
    }

    if (err && err.code === 'ECONNABORTED') {
      return { canceled: false, message: '请求超时，请稍后重试。' };
    }
    return {
      canceled: false,
      message: '无法连接后端服务，请确认已运行 python backend/server.py（默认 http://127.0.0.1:8000）。',
      detail: (err && err.message) || ''
    };
  }

  /* -------------------------------------------- 健康检查 */
  function health() {
    return http.get('/api/health').then(function (res) { return res.data; });
  }

  /* -------------------------------------------- 非流式生成 */
  function createPlan(payload, options) {
    options = options || {};
    return http.post('/api/plan', payload, { signal: options.signal })
      .then(function (res) { return res.data; });
  }

  /* -------------------------------------------- SSE 解析器 */
  function createSseParser(handlers) {
    var buffer = '';
    var consumed = 0;

    function dispatch(raw) {
      var event = 'message';
      var data = '';
      raw.split('\n').forEach(function (line) {
        if (line.indexOf('event:') === 0) {
          event = line.slice(6).trim();
        } else if (line.indexOf('data:') === 0) {
          data += line.slice(5).replace(/^\s/, '');
        }
      });
      if (!data) return;
      var payload;
      try {
        payload = JSON.parse(data);
      } catch (e) {
        payload = { raw: data };
      }
      var fn = handlers[event] || handlers.message;
      if (typeof fn === 'function') {
        try { fn(payload); } catch (e) {
          if (global.console) console.error('[SSE handler]', event, e);
        }
      }
    }

    return {
      /** 把 XHR 累积的响应文本喂进来，切分出完整事件 */
      feed: function (text) {
        if (typeof text !== 'string' || !text.length) return;
        if (text.length < consumed) { consumed = 0; buffer = ''; }  // 防御：文本被重置
        buffer += text.slice(consumed);
        consumed = text.length;
        var idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          dispatch(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
        }
      },
      /** 结束时把残留内容也处理掉 */
      flush: function () {
        if (buffer.trim()) {
          dispatch(buffer);
          buffer = '';
        }
      }
    };
  }

  /* -------------------------------------------- 流式生成 */
  function createPlanStream(payload, handlers, options) {
    options = options || {};
    handlers = handlers || {};

    var failure = null;
    var parser = createSseParser({
      message: handlers.message,
      start: handlers.start,
      reasoning: handlers.reasoning,
      content: handlers.content,
      finish: handlers.finish,
      usage: handlers.usage,
      done: handlers.done,
      // 服务端在流里报错：记录下来，等连接结束后统一抛出，
      // 因为事件回调里 throw 会被浏览器吞掉，没法被 Promise 捕获。
      error: function (data) {
        failure = new Error((data && data.error) || '生成失败');
        failure.response = {
          status: 502,
          data: { error: (data && data.error) || '生成失败', detail: (data && data.detail) || '' }
        };
      }
    });

    return http.post('/api/plan/stream', payload, {
      signal: options.signal,
      responseType: 'text',
      headers: { 'Accept': 'text/event-stream' },
      onDownloadProgress: function (e) {
        var target = e && e.event && e.event.target;
        if (target && typeof target.responseText === 'string') {
          parser.feed(target.responseText);
        }
      }
    }).then(function (res) {
      parser.feed(typeof res.data === 'string' ? res.data : '');
      parser.flush();
      if (failure) throw failure;
      return res.data;
    }, function (err) {
      parser.flush();
      if (failure) throw failure;
      throw err;
    });
  }

  /* -------------------------------------------- 计划的保存与管理 */
  function savePlan(payload) {
    return http.post('/api/plans', payload).then(function (res) { return res.data; });
  }

  function listPlans(params) {
    var query = [];
    if (params && params.keyword) query.push('keyword=' + encodeURIComponent(params.keyword));
    if (params && params.limit) query.push('limit=' + encodeURIComponent(params.limit));
    var qs = query.length ? ('?' + query.join('&')) : '';
    return http.get('/api/plans' + qs).then(function (res) { return res.data; });
  }

  function getPlan(id) {
    return http.get('/api/plans/' + encodeURIComponent(id)).then(function (res) { return res.data; });
  }

  function starPlan(id, starred) {
    return http.patch('/api/plans/' + encodeURIComponent(id), { starred: !!starred })
      .then(function (res) { return res.data; });
  }

  function deletePlan(id) {
    return http.delete('/api/plans/' + encodeURIComponent(id)).then(function (res) { return res.data; });
  }

  function exportUrl() {
    return BASE_URL + '/api/plans/export';
  }

  global.StudyPlanAPI = {
    BASE_URL: BASE_URL,
    http: http,
    health: health,
    createPlan: createPlan,
    createPlanStream: createPlanStream,
    savePlan: savePlan,
    listPlans: listPlans,
    getPlan: getPlan,
    starPlan: starPlan,
    deletePlan: deletePlan,
    exportUrl: exportUrl,
    normalizeError: normalizeError
  };
})(window);
