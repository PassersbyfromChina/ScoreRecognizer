import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/** 兜底错误边界：任何界面崩溃时给出可操作的提示，避免白屏。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("界面出错：", error, info);
    this.setState({ error, info });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center">
        <div className="card" style={{ maxWidth: 560, margin: 24 }}>
          <div className="card-body" style={{ padding: 28 }}>
            <h2 style={{ fontSize: 18, marginBottom: 10 }}>这个界面出了点问题</h2>
            <p className="muted" style={{ lineHeight: 1.8, marginBottom: 16 }}>
              已经保存的名单、答题卡和识别结果都存在本机，不会丢失。可以先重新加载应用；如果反复出现，把下面的信息发给开发者。
            </p>
            <pre
              className="small mono"
              style={{
                whiteSpace: "pre-wrap",
                background: "#f8fafc",
                border: "1px solid var(--line)",
                borderRadius: 10,
                padding: 12,
                maxHeight: 180,
                overflow: "auto",
                color: "var(--ink-2)",
              }}
            >
              {String(this.state.error.message || this.state.error)}
            </pre>
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn btn-primary" onClick={() => window.location.reload()}>
                重新加载
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
