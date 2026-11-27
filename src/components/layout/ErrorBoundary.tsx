import React from 'react';
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-react';
import { resetAndWipeVault } from '../../core/storage';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
  confirmReset: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: '',
      confirmReset: false,
    };
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    const message = error instanceof Error ? error.message : String(error || 'Unexpected UI error');
    return {
      hasError: true,
      errorMessage: message.slice(0, 220),
    };
  }

  componentDidCatch(error: Error): void {
    console.error('[LowCon] Unhandled render error:', error.message);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleResetWorkspace = (): void => {
    resetAndWipeVault();
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        className="flex min-h-screen w-full items-center justify-center bg-[var(--lc-bg)] p-6 text-[var(--lc-ink)]"
      >
        <div className="w-full max-w-[460px] rounded-[12px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-6 text-[var(--lc-surf-ink)] shadow-xl">
          <div className="flex items-center gap-2.5 text-[var(--lc-danger)]">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <h1 className="text-[17px] font-bold text-[var(--lc-surf-ink)]">
              LowCon encountered a rendering error
            </h1>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--lc-surf-ink2)]">
            Your local workspace data was not sent anywhere. Try reloading the workbench first. If
            the issue persists due to corrupted local state, you can reset local storage below.
          </p>
          {this.state.errorMessage && (
            <pre className="mt-3 max-h-28 overflow-auto rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surf-hover)]/60 p-2.5 font-mono text-[11.5px] whitespace-pre-wrap text-[var(--lc-surf-ink2)]">
              {this.state.errorMessage}
            </pre>
          )}
          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center gap-1.5 rounded-[7px] bg-[var(--lc-accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)]"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Reload workbench</span>
            </button>
            {!this.state.confirmReset ? (
              <button
                type="button"
                onClick={() => this.setState({ confirmReset: true })}
                className="inline-flex items-center gap-1.5 rounded-[7px] border border-[var(--lc-danger)]/40 px-3 py-2 text-[12.5px] font-medium text-[var(--lc-danger)] hover:bg-[var(--lc-danger)]/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Reset local workspace</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={this.handleResetWorkspace}
                className="inline-flex items-center gap-1.5 rounded-[7px] bg-[var(--lc-danger)] px-3 py-2 text-[12.5px] font-semibold text-[var(--lc-danger-contrast)] hover:opacity-90"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Confirm erase &amp; reload</span>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
