/**
 * 客户端半：在输入框的「模型 / 推理等级」菜单里加一行「启用跨会话换模型（本会话）」。
 *
 * 位置就是智能体团队协作开关所在的槽 `conversation.input.model.options`（session 作用域），
 * order 比 agent-team 大，所以排在它下面。
 *
 * 状态读写走桥的本机 HTTP：GET/POST http://127.0.0.1:39881/features/model-tools。
 * 端口是桥的默认端口；改桥端口的话这里也要同步改。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'session-bridge';

    const zh = {
      'model.label': '启用跨会话换模型',
      'model.info': '允许本会话读取可调模型、给其它会话换模型、给其它会话发消息。关闭时这些调用会被拒绝；只读的会话/模型查询不受影响。',
      'model.failed': '未能保存开关：{message}',
    };
    const en = {
      'model.label': 'Enable cross-session model changes',
      'model.info': 'Lets this session read the model catalog, switch another session’s model, and message another session. When off, those calls are refused; read-only session/model queries still work.',
      'model.failed': 'Could not save the switch: {message}',
    };

    // 桥的默认端口；改端口时同步改这里
    const BRIDGE = 'http://127.0.0.1:39881';

    function endpoint(sessionId) {
      return BRIDGE + '/features/model-tools?sessionId=' + encodeURIComponent(sessionId);
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '6px 10px',
      minHeight: '32px',
    };
    const labelStyle = { fontSize: '13px', lineHeight: 1.4 };

    function ModelToolsToggle(props) {
      const { t, sessionId, locked } = props || {};
      const [enabled, setEnabled] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState('');

      // 只给顶层会话显示（子代理会话不显示），和 agent-team 的行为一致
      const addressedChild = props && props.useSession
        ? props.useSession((snapshot) => snapshot && snapshot.subagent !== null)
        : false;
      const listedChild = props && props.useSessions
        ? props.useSessions((state) => Boolean(state && state.byId && state.byId[props.sessionId] && state.byId[props.sessionId].origin === 'subagent'))
        : false;

      React.useEffect(() => {
        if (!sessionId) return undefined;
        let alive = true;
        fetch(endpoint(sessionId), { method: 'GET' })
          .then((response) => response.json())
          .then((value) => {
            if (alive) setEnabled(Boolean(value && value.enabled));
          })
          .catch(() => {
            if (alive) setEnabled(false);
          });
        return () => {
          alive = false;
        };
      }, [sessionId]);

      if (addressedChild || listedChild) return null;
      if (enabled === null) return null;

      const change = (next) => {
        if (busy) return;
        setBusy(true);
        setFailure('');
        fetch(BRIDGE + '/features/model-tools', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, enabled: next }),
        })
          .then((response) => response.json())
          .then((value) => {
            if (value && value.ok) setEnabled(Boolean(value.enabled));
            else setFailure(String((value && value.error) || 'unknown error'));
          })
          .catch((error) => setFailure(String(error)))
          .finally(() => setBusy(false));
      };

      const info = t ? t('model.info') : '';
      const failureText = failure && t ? t('model.failed', { message: failure }) : failure;

      return h(
        'div',
        { style: rowStyle, 'data-session-model-toggle': sessionId },
        h(
          'span',
          { style: labelStyle, title: info },
          t ? t('model.label') : 'Enable cross-session model changes',
        ),
        h(
          'span',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          failureText
            ? h('span', { style: { fontSize: '12px', color: 'var(--vb-color-danger, #d64545)' } }, failureText)
            : null,
          h('input', {
            type: 'checkbox',
            checked: enabled,
            disabled: busy || Boolean(locked),
            'aria-label': t ? t('model.label') : 'Enable cross-session model changes',
            onChange: (event) => change(Boolean(event.target.checked)),
            style: { width: '18px', height: '18px', cursor: busy ? 'default' : 'pointer' },
          }),
        ),
      );
    }

    ModelToolsToggle.__sessionBridge = NS;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register(NS, { zh, en });
        ctx.slots.inject('conversation.input.model.options', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.model.options',
              id: 'session-bridge',
              order: 20,
              locale: NS,
            },
            ModelToolsToggle,
          ),
        );
      },
    };
  },
});
