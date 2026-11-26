import React from 'react';
import { Cpu } from 'lucide-react';
import type { ModelOrigin } from '../../core/modelNames';

interface ModelOriginIconProps {
  origin: ModelOrigin;
  size?: number;
  className?: string;
}

const ORIGIN_TITLES: Record<ModelOrigin, string> = {
  google: 'Google / Gemma',
  qwen: 'Qwen',
  meta: 'Meta / Llama',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  microsoft: 'Microsoft / Phi',
  anthropic: 'Anthropic',
  inkling: 'Thinking Machines / Inkling',
  default: 'Local Model',
};

export const ModelOriginIcon: React.FC<ModelOriginIconProps> = ({
  origin,
  size = 14,
  className = '',
}) => {
  const title = ORIGIN_TITLES[origin];
  const baseProps = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    className: `shrink-0 ${className}`.trim(),
    'aria-hidden': true as const,
    'data-origin': origin,
    'data-testid': `model-origin-icon-${origin}`,
  };

  switch (origin) {
    case 'google':
      return (
        <svg {...baseProps} fill="none">
          <title>{title}</title>
          <path
            d="M21.8 12.23c0-.71-.06-1.4-.18-2.05H12v3.88h5.5a4.7 4.7 0 0 1-2.04 3.08v2.56h3.3c1.93-1.78 3.04-4.4 3.04-7.47Z"
            fill="#4285F4"
          />
          <path
            d="M12 22c2.75 0 5.06-.91 6.75-2.47l-3.3-2.56c-.91.61-2.08.98-3.45.98-2.65 0-4.9-1.79-5.7-4.2H2.9v2.64A10 10 0 0 0 12 22Z"
            fill="#34A853"
          />
          <path
            d="M6.3 13.75a5.98 5.98 0 0 1 0-3.5V7.61H2.9a10.01 10.01 0 0 0 0 8.78l3.4-2.64Z"
            fill="#FBBC05"
          />
          <path
            d="M12 6.05c1.5 0 2.84.52 3.9 1.53l2.92-2.92C17.05 3.01 14.74 2 12 2A10 10 0 0 0 2.9 7.61l3.4 2.64c.8-2.41 3.05-4.2 5.7-4.2Z"
            fill="#EA4335"
          />
        </svg>
      );

    case 'qwen':
      return (
        <svg {...baseProps} fill="none">
          <title>{title}</title>
          <path
            d="M12.3202 2.12109C12.4682 2.12111 12.6026 2.19986 12.6732 2.32612L13.8602 4.40385H19.0069C19.155 4.40385 19.2895 4.48272 19.3601 4.60901L20.7534 6.95158C20.8647 7.14713 20.8647 7.38889 20.7534 7.58444L19.3601 9.92701L22 14.5103L21.5329 13.914C21.6443 14.1096 21.6443 14.3513 21.5329 14.5469L20.1396 16.8895C20.069 17.0158 19.9345 17.0945 19.7865 17.0945H17.429L14.789 21.6765C14.7184 21.8027 14.584 21.8815 14.436 21.8815H11.9998L17.429 11.7387L18.8088 14.175H21.4487L18.8088 9.59307L20.2021 7.2505H9.57154L10.9648 4.81431L9.57154 2.32639L6.57848 7.2505H3.47681L9.21851 16.906H6.57848L5.00046 19.3938H10.1474L11.6871 21.8813C11.5391 21.8813 11.4048 21.8027 11.3342 21.6765L10.1474 19.5987H5.00046C4.85246 19.5987 4.71805 19.52 4.64743 19.3937L3.25401 17.0511C3.14266 16.8556 3.14268 16.6138 3.25401 16.4183L4.44094 14.3405L2.08352 10.0885C1.97216 9.89298 1.97216 9.65123 2.08352 9.45568L3.47681 7.11311C3.54742 6.98684 3.68184 6.90809 3.82984 6.90808H6.57848L9.21838 2.32612C9.289 2.19983 9.42352 2.12109 9.57154 2.12109H12.3202Z"
            fill="#615CED"
          />
          <path d="M15.6229 10.5827L11.9997 16.3244L8.59932 10.5827H15.6229Z" fill="#615CED" />
        </svg>
      );

    case 'meta':
      return (
        <svg {...baseProps} fill="none">
          <title>{title}</title>
          <path
            d="M6.9 6.2c-2.6 0-4.4 2.4-4.4 5.8 0 3.2 1.6 5.8 4 5.8 1.9 0 3.2-1.4 4.7-3.9l.8-1.4.8 1.4c1.5 2.5 2.8 3.9 4.7 3.9 2.4 0 4-2.6 4-5.8 0-3.4-1.8-5.8-4.4-5.8-1.9 0-3.4 1.3-5.1 4-1.7-2.7-3.2-4-5.1-4Z"
            stroke="#0081FB"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );

    case 'mistral':
      return (
        <svg {...baseProps} fill="none">
          <title>{title}</title>
          <rect x="3" y="4" width="4" height="4" fill="#F7D046" />
          <rect x="17" y="4" width="4" height="4" fill="#F7D046" />
          <rect x="3" y="8" width="7.5" height="4" fill="#F2A73B" />
          <rect x="13.5" y="8" width="7.5" height="4" fill="#F2A73B" />
          <rect x="3" y="12" width="18" height="4" fill="#EE792F" />
          <rect x="3" y="16" width="4" height="4" fill="#EB5829" />
          <rect x="10" y="16" width="4" height="4" fill="#EB5829" />
          <rect x="17" y="16" width="4" height="4" fill="#EB5829" />
        </svg>
      );

    case 'deepseek':
      return (
        <svg {...baseProps} fill="none">
          <title>{title}</title>
          <path
            d="M20.5 11.2c-.8-3.9-4.1-6.7-8.2-6.7-4.5 0-8.3 3.6-8.3 8.1 0 3.7 2.5 6.8 6 7.7 2.6.7 5.7.1 7.8-1.8 1.6-1.4 2.3-3.2 2.2-4.8-.6.6-1.6.9-2.5.7-.9-.2-1.5-.9-1.7-1.7 1.7-.4 3.4-.9 4.7-1.5Z"
            fill="#4D6BFE"
          />
          <circle cx="10.2" cy="11.2" r="1.3" fill="#FFFFFF" />
        </svg>
      );

    case 'microsoft':
      return (
        <svg {...baseProps} fill="none">
          <title>{title}</title>
          <rect x="3" y="3" width="8.5" height="8.5" rx="1" fill="#F25022" />
          <rect x="12.5" y="3" width="8.5" height="8.5" rx="1" fill="#7FBA00" />
          <rect x="3" y="12.5" width="8.5" height="8.5" rx="1" fill="#00A4EF" />
          <rect x="12.5" y="12.5" width="8.5" height="8.5" rx="1" fill="#FFB900" />
        </svg>
      );

    case 'openai':
      return (
        <svg {...baseProps} fill="none">
          <title>{title}</title>
          <path
            d="M12 2.8a4.5 4.5 0 0 1 4.1 2.6 4.5 4.5 0 0 1 4.4 5.8 4.5 4.5 0 0 1-1.9 5.5 4.5 4.5 0 0 1-5.8 4.2 4.5 4.5 0 0 1-5.8-1.6 4.5 4.5 0 0 1-4-6.1 4.5 4.5 0 0 1 2.2-5.4A4.5 4.5 0 0 1 12 2.8Z"
            stroke="currentColor"
            strokeWidth="1.9"
          />
          <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );

    case 'anthropic':
      return (
        <svg {...baseProps} fill="none">
          <title>{title}</title>
          <path
            d="M14.2 4.5h2.6L21 19.5h-2.6l-1.1-4H13l-1.1 4H9.4l4.8-15Zm.9 3.7L13.6 13h3l-1.5-4.8Z"
            fill="currentColor"
          />
          <path d="M7.6 4.5h2.5L6.2 19.5H3.6L7.6 4.5Z" fill="currentColor" />
        </svg>
      );

    case 'inkling':
      return (
        <svg {...baseProps} fill="none">
          <title>{title}</title>
          <path
            d="M12 2.5C8.5 6.8 6 10.1 6 13.7A6 6 0 0 0 12 19.7a6 6 0 0 0 6-6c0-3.6-2.5-6.9-6-11.2Z"
            fill="#14B8A6"
          />
          <path
            d="M9.5 13.5c.8-1.5 1.8-2.3 2.5-2.3.7 0 1.7.8 2.5 2.3a2.8 2.8 0 0 1-5 0Z"
            fill="#FFFFFF"
            fillOpacity="0.88"
          />
        </svg>
      );

    case 'default':
    default:
      return (
        <Cpu
          size={size}
          aria-hidden="true"
          data-origin="default"
          data-testid="model-origin-icon-default"
          className={`shrink-0 text-[var(--lc-surf-mute)] ${className}`.trim()}
        />
      );
  }
};
