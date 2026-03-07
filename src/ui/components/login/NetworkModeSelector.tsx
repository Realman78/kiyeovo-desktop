import { NETWORK_MODES } from '../../../core/constants';
import type { NetworkMode } from '../../../core/types';
import { Button } from '../ui/Button';

type NetworkModeSelectorProps = {
  loading: boolean;
  saving: boolean;
  error?: string | null;
  onChange: (mode: NetworkMode) => void;
};

const MODE_COPY: Record<NetworkMode, { title: string; description: string }> = {
  fast: {
    title: 'Fast Mode',
    description: 'Low latency, more stable. Voice & video calls enabled TODO check. Weaker anonymity than Tor.',
  },
  anonymous: {
    title: 'Anonymous Mode',
    description: 'Routes traffic through Tor. Stronger anonymity, high latency, stability depends on Tor.',
  },
};

export function NetworkModeSelector({ loading, saving, error, onChange }: NetworkModeSelectorProps) {
  const isBusy = loading || saving;

  return (
    <div className="w-114 rounded-lg border border-primary/30 bg-card/40 p-4">
      <div className="mb-3 text-center">
        <p className="text-sm font-semibold text-foreground">Network Mode</p>
        <p className="text-xs text-muted-foreground">Choose transport profile before login</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant='outline'
          onClick={() => onChange(NETWORK_MODES.FAST)}
          disabled={isBusy}
        >
          Fast
        </Button>
        <Button
          type="button"
          variant='outline'
          onClick={() => onChange(NETWORK_MODES.ANONYMOUS)}
          disabled={isBusy}
        >
          Anonymous (Tor)
        </Button>

      <div className="mt-3 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground">{MODE_COPY["fast"].title}</p>
        <p>{MODE_COPY["fast"].description}</p>
        {error ? <p className="mt-1 text-destructive">{error}</p> : null}
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground">{MODE_COPY["anonymous"].title}</p>
        <p>{MODE_COPY["anonymous"].description}</p>
        {error ? <p className="mt-1 text-destructive">{error}</p> : null}
      </div>
      </div>

    </div>
  );
}
