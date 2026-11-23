/**
 * 客户端半：在输入框的「模型 / 推理等级」菜单里加一行「允许本会话换别人的模型」。
 *
 * 位置是智能体团队协作开关所在的槽 `conversation.input.model.options`（session 作用域），
 * order 比 agent-team 大，所以排在它下面；开关样式用同一套 primitives 的胶囊 Switch。
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

    // 和 agent-team 同一套 primitives；取不到时退回原生 checkbox（仍可用，只是样式不同）
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      primitives = null;
    }
    const Switch = primitives && primitives.Switch;
    const Tooltip = primitives && primitives.Tooltip;
    const Button = primitives && primitives.Button;
    const InfoIcon = primitives && primitives.IconInfoOutlineRegular;

    const zh = {
      'model.label': '允许本会话换别人的模型',
      'model.infoLabel': '关于跨会话换模型',
      'model.description':
        '开启后，本会话可以：读取可调模型列表、给其它会话换模型、给其它会话发消息。关闭后这些操作会被拒绝；查看会话和模型目录仍然可用。',
      'model.failed': '没能保存开关：{message}',
    };
    const en = {
      'model.label': "Let this session switch other sessions' models",
      'model.infoLabel': 'About cross-session model switching',
      'model.description':
        "When on, this session can read the model catalog, switch another live session's model, and message another session. When off, those calls are refused; listing sessions and models still works.",
      'model.failed': 'Could not save the switch: {message}',
    };

    // 桥的默认端口；改端口时同步改这里
    const BRIDGE = 'http://127.0.0.1:39881';

    function endpoint(sessionId) {
      return BRIDGE + '/features/model-tools?sessionId=' + encodeURIComponent(sessionId);
    }

    // 与 agent-team 的 TeamModeToggle 一致的排布：左侧标签 + 说明图标，右侧胶囊开关
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '6px 10px',
      minHeight: '34px',
    };
    const labelStyle = { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', lineHeight: 1.4 };
    const infoButtonStyle = {
      width: '16px',
      height: '16px',
      minWidth: '16px',
      padding: 0,
      color: 'inherit',
      opacity: 0.65,
    };
    const failureStyle = { fontSize: '12px', color: 'var(--vb-color-danger, #d64545)', maxWidth: '180px' };

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

      const label = t ? t('model.label') : "Let this session switch other sessions' models";
      const description = t ? t('model.description') : '';
      const failureText = failure && t ? t('model.failed', { message: failure }) : failure;

      const control = Switch
        ? h(Switch, {
            checked: enabled,
            disabled: busy || Boolean(locked),
            label: label,
            onChange: change,
          })
        : h('input', {
            type: 'checkbox',
            checked: enabled,
            disabled: busy || Boolean(locked),
            'aria-label': label,
            onChange: (event) => change(Boolean(event.target.checked)),
            style: { width: '18px', height: '18px', cursor: busy ? 'default' : 'pointer' },
          });

      return h(
        'div',
        { style: rowStyle, 'data-session-model-toggle': sessionId },
        h(
          'span',
          { style: labelStyle },
          h('span', null, label),
          Tooltip && Button && InfoIcon
            ? h(
                Tooltip,
                { label: description, side: 'top', delayMs: 300, maxWidth: 320, portal: true, openOnClick: true },
                h(
                  Button,
                  {
                    variant: 'ghost',
                    size: 'sm',
                    style: infoButtonStyle,
                    'aria-label': t ? t('model.infoLabel') : 'About cross-session model switching',
                  },
                  h(InfoIcon, { size: 11, 'aria-hidden': 'true' }),
                ),
              )
            : null,
        ),
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
          failureText ? h('span', { style: failureStyle, role: 'alert' }, failureText) : null,
          control,
        ),
      );
    }

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
