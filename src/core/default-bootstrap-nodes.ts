export const DEFAULT_BOOTSTRAP_NODES = ["/ip4/188.166.161.63/tcp/9000/p2p/12D3KooWHhZDapttnphEpmqA8EKa6S2petfdNQTtMKtpS7SuGs3n", "/onion3/zzvhf52loj267us32iou32j54kgm64cwmbcp6phkpfysqsk625i3ohid:9000/p2p/12D3KooWDvF8tkCqW9CdWhJ9UKFQNGYd8QcgnBHxjTPfobfyFgAi"]

export type DefaultIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

// Temporary hardcoded WebRTC servers for Fast mode calling.
// Replace credentials with your production values.
export const DEFAULT_WEBRTC_ICE_SERVERS: DefaultIceServer[] = [
  { urls: 'stun:188.166.161.63:3478' },
  {
    urls: 'turn:188.166.161.63:3478?transport=udp',
    username: 'kiyeovo',
    credential: 'marinparin',
  },
  {
    urls: 'turn:188.166.161.63:3478?transport=tcp',
    username: 'kiyeovo',
    credential: 'marinparin',
  },
];
