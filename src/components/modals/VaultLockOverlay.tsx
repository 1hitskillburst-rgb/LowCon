import React, { useState } from 'react';
import { Lock, Unlock } from 'lucide-react';

interface VaultLockOverlayProps {
  onUnlock: (passphrase: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export const VaultLockOverlay: React.FC<VaultLockOverlayProps> = ({ onUnlock }) => {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!passphrase) {
      setError('Enter your vault passphrase to decrypt local storage.');
      return;
    }
    setIsUnlocking(true);
    const res = await onUnlock(passphrase);
    setIsUnlocking(false);
    if (!res.ok) {
      setError(res.error);
    } else {
      setPassphrase('');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-lock-title"
      data-testid="vault-lock-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--lc-side)] p-6 text-[var(--lc-surf-ink)]"
    >
      <div className="w-full max-w-[440px] rounded-[10px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-6 shadow-xl">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-[var(--lc-accent)] text-[var(--lc-accent-contrast)]">
            <Lock className="h-4 w-4" />
          </div>
          <div>
            <h1 id="vault-lock-title" className="text-[18px] font-bold text-[var(--lc-surf-ink)]">
              LowCon Vault Locked
            </h1>
            <p className="text-[12px] text-[var(--lc-surf-mute)]">
              Encrypted with AES-256-GCM + PBKDF2-SHA256
            </p>
          </div>
        </div>

        <p className="mt-4 text-[13.5px] leading-relaxed text-[var(--lc-surf-ink2)]">
          Your sessions, memory notes, model profiles, and settings are sealed in authenticated
          ciphertext. Enter your passphrase to decrypt and resume your workspace.
        </p>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-3">
          <div>
            <label
              htmlFor="vault-unlock-passphrase"
              className="block text-[12px] font-semibold text-[var(--lc-surf-ink2)]"
            >
              Vault Passphrase
            </label>
            <input
              id="vault-unlock-passphrase"
              type="password"
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Enter passphrase"
              className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-2 text-[14px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
            />
          </div>

          {error && (
            <div
              role="alert"
              data-testid="vault-unlock-error"
              className="rounded-[6px] border border-[var(--lc-danger)]/30 bg-[var(--lc-danger)]/10 px-3 py-2 text-[12.5px] font-medium text-[var(--lc-danger)]"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isUnlocking}
            className="flex w-full items-center justify-center gap-1.5 rounded-[8px] bg-[var(--lc-accent)] px-4 py-2 text-[13.5px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)] disabled:opacity-50"
          >
            <Unlock className="h-4 w-4" />
            <span>{isUnlocking ? 'Decrypting...' : 'Unlock Workspace'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
