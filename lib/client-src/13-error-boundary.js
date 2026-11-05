    // Codes worth switching on. Host list is DEFAULT_SWITCH_CODES; config may
    // add extras — those render as separate checked boxes so a custom rule is
    // not dropped on first save.
    const KNOWN_CODES = ['QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'UNKNOWN_MODEL', 'AUTH'];

    // (issue 273): keep the settings list item mounted if the section throws.
        const bestEffort = (label, fn) => {
          try { return fn(); } catch (err) {
            try { console.debug('[dsh-key-rotation] best-effort ' + label, err); } catch { /* console unavailable */ }
            return undefined;
          }
        };
    class KeyRotationErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        bestEffort('error-boundary.log', () => { console.error('[dsh-key-rotation] settings card crashed', error, info); });
      }
      render() {
        if (this.state.error) {
          return React.createElement('div', { className: 'krot krot-err', style: { padding: 12 } },
            React.createElement('p', null, 'Key Rotation settings failed to render.'),
            React.createElement('p', { style: { fontSize: 11, opacity: 0.8 } }, String(this.state.error?.message || this.state.error)),
            React.createElement('button', {
              type: 'button',
              className: 'krot-btn',
              onClick: () => this.setState({ error: null }),
            }, 'Retry'));
        }
        return this.props.children;
      }
    }

