import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey, PeerId, Ed25519PrivateKey } from '@libp2p/interface';

export class PeerIdManager {
  static async loadOrCreate(filePath: string): Promise<{ peerId: PeerId; privateKey: PrivateKey }> {
    let privateKey: PrivateKey;
    let peerId: PeerId;

    if (existsSync(filePath)) {
      try {
        const keyBytes = await readFile(filePath);
        
        privateKey = privateKeyFromProtobuf(keyBytes) as Ed25519PrivateKey;
        
        peerId = peerIdFromPrivateKey(privateKey);
        
        console.log(`Loaded peer ID: ${peerId.toString()}`);
      } catch (err: any) {
        console.log('Error loading private key:', err);
        
        privateKey = await generateKeyPair('Ed25519');
        peerId = peerIdFromPrivateKey(privateKey);
        
        console.log(`Generated new peer ID: ${peerId.toString()}`);
      }
    } else {
      console.log(`Creating new private key and saving to ${filePath}`);
      
      privateKey = await generateKeyPair('Ed25519');
      peerId = peerIdFromPrivateKey(privateKey);
      
      console.log(`Generated new peer ID: ${peerId.toString()}`);
    }

    try {
      const keyBytes = privateKeyToProtobuf(privateKey);
      await writeFile(filePath, keyBytes);
      console.log(`Private key saved to ${filePath}`);
    } catch (err: any) {
      console.log(`Failed to save private key: ${err.message}`);
    }

    return { peerId, privateKey };
  }
}