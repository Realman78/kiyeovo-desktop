## Kiyeovo Desktop — Tehnička dokumentacija (HR)

### Svrha dokumenta

Ovaj dokument je "single-source" tehnički pregled trenutne desktop verzije Kiyeovo aplikacije. 
Cilj je da se u novim AI razgovorima može brzo dati kompletan kontekst bez ručnog objašnjavanja arhitekture, flowova i ključnih dizajnerskih odluka.

---

### TL;DR (brzi kontekst)

- Kiyeovo Desktop je **Electron + React + libp2p** P2P messenger.
- Podržava dva mrežna moda:
  - `fast` (TCP + Circuit Relay v2 + DCUtR)
  - `anonymous` (Tor onion putanja)
- Mode isolation je ugrađen kroz:
  - mode-specifične protokole
  - mode-specifične DHT namespace/prefikse
  - mode-specifične pubsub topic prefikse
  - mode-aware DB upite
- Direktni chat koristi:
  - key exchange (X25519 + Ed25519 potpisi)
  - sesijske simetrične ključeve (HKDF)
  - online slanje + offline fallback u DHT bucket
- Grupni chat koristi:
  - mode-scoped GossipSub teme za realtime
  - control poruke preko pairwise offline bucket mehanizma
  - ACK/republish mehanizme za pouzdanost
  - rotaciju group key epoha
- DHT zapisi su validirani/selektirani validatorima (username, offline, group offline, group info latest/versioned).

---

### 1. Visoka arhitektura

Kiyeovo Desktop je podijeljen na dva glavna procesa:

1. **Electron Main process (Node.js runtime)**
   - inicijalizira P2P core
   - upravlja Tor lifecycle-om
   - drži SQLite konekciju
   - izlaže IPC API prema UI-ju

2. **Renderer process (React UI + Redux)**
   - prikazuje login/chat/settings UI
   - šalje zahtjeve kroz `preload` bridge
   - prima eventove iz core-a (nove poruke, KX događaji, file progress, group update-i)

U pozadini radi **P2P Core** koji sadrži ključne module:
- `MessageHandler`
- `KeyExchange`
- `SessionManager`
- `UsernameRegistry`
- `GroupCreator` / `GroupResponder` / `GroupMessaging` / `GroupOfflineManager`
- `FileHandler`
- `OfflineMessageManager`

---

### 2. Mrežni modovi i izolacija

#### 2.1 Modovi

- `fast`
  - transport: TCP + relay transport
  - koristi Circuit Relay v2 i DCUtR
  - fokus: niža latencija i bolja UX responzivnost

- `anonymous`
  - outgoing kroz Tor SOCKS5 putanju
  - onion announce adrese
  - fokus: privatnost/anonimnost

#### 2.2 No-bridge pravilo

Sustav je dizajniran da zapisi iz jednog moda nisu vidljivi drugom modu:
- različiti protocol IDs (`chat`, `file-transfer`, `bucket-nudge`, `dht`)
- različiti DHT namespace prefiksi (`offline`, `username`, `groupOffline`, `groupInfoLatest`, `groupInfoVersion`)
- različiti pubsub topic prefiksi
- mode-aware DB upiti i queue obrada

#### 2.3 Mode switch

Promjena moda radi se kroz postavku + **app restart** (nema hot-reinit u istom procesu).

---

### 3. Startup i lifecycle flow

1. Electron app starta i otvara glavni prozor.
2. Main process čita `network_mode` iz DB settings.
3. Tor manager se podiže samo kad je potreban (`anonymous`).
4. Učitava/kreira se enkriptirani korisnički identitet za aktivni mode.
5. Kreira se libp2p node (`node-setup`) s mode-odgovarajućim stackom.
6. Pokušava se spajanje na bootstrap node-ove.
7. Starta DHT status checker (connected = DHT-reachable, ne samo “ima konekciju”).
8. Inicijalizira se username registry.
9. Inicijalizira se message/group/file handler sloj.
10. UI dobiva eventove i puni stanje (chat list, status, pending state).

---

### 4. Identity i autentikacija

Kiyeovo koristi enkriptirane identitete spremljene lokalno u SQLite.

Identitet uključuje:
- libp2p identity key (Peer ID)
- signing ključ (Ed25519)
- offline encryption ključ (RSA)
- notifications ključni par

Sigurnosni model:
- enkripcija identiteta: AES-GCM
- KDF: scrypt
- opcionalno spremanje lozinke u OS keychain (`keytar`)
- fallback: prompt u UI
- recovery phrase (BIP39) za oporavak
- login attempts + cooldown zaštita

Napomena: u trenutnoj implementaciji identitet je mode-aware u bazi (per-mode zapis), pa je arhitektura spremna za jaču privatnosnu separaciju između modova.

---

### 5. Direktni chat flow

#### 5.1 Online flow

1. Korisnik šalje poruku prema username-u ili peer ID-u.
2. `MessageHandler.sendMessage` zove `ensureUserSession`:
   - pronađe kontakt lokalno ili kroz DHT lookup
   - pokrene key exchange ako sesija ne postoji
3. Ako je sesija aktivna, poruka ide kroz `chatProtocol`.
4. Sadržaj poruke je enkriptiran sesijskim ključem.
5. Poruka se sprema lokalno i emitira UI event.

#### 5.2 Key exchange

- `key_exchange_init` / `response` / `rejected`
- potpisi na key exchange payload (Ed25519)
- zaštita od replay/stale poruka (timestamp age check)
- iz ECDH shared secret-a deriviraju se directional ključevi (HKDF)
- automatska rotacija ključa nakon praga poruka

#### 5.3 Offline fallback

Ako online dial ne uspije (peer offline / relay fail / timeout), ide fallback:
- poruka se kriptira za offline bucket
- zapis ide u DHT store
- store je potpisan, validiran i verzioniran
- ACK mehanizam čisti pročitane poruke iz sender bucket-a

---

### 6. Grupni chat flow

Grupni sustav ima dva plana prijenosa:

1. **Data plane (realtime):** GossipSub po group topicu
2. **Control plane (pouzdanost/rekoncilijacija):** control poruke kroz pairwise offline bucket + ACK/republish

#### 6.1 Lifecycle

- Creator stvara grupu i šalje invite.
- Invitee prihvaća/odbija.
- Creator šalje `GROUP_WELCOME` + state update.
- Aktivirani članovi subscribaju se na topic tekuće key epohe.

#### 6.2 Rotacija ključa i epoch model

- Group key se rotira na membership promjene (join/leave/kick).
- Svaka epoha ima `key_version`.
- Sustav čuva history i boundaries za sigurnu obradu starih/new poruka.
- Stare teme mogu ostati kratko aktivne (grace) da se ublaži transition gap.

#### 6.3 Offline grupni sadržaj

Ako publish nema aktivnih subscriber-a:
- poruka ide u group offline bucket
- bucket je per-group, per-key-version, per-sender
- store je kompresiran, potpisan i verzioniran

#### 6.4 Nudge mehanizam

Bucket nudges služe kao best-effort signal za brže refetchanje.
Nudges su ograničeni i validirani (npr. blocked/unknown sender guard), a fallback i dalje ostaje DHT periodic check.

---

### 7. File transfer

File transfer ide kroz zaseban protocol (`fileTransferProtocol`) i radi preko postojećeg trust/session sloja.

Flow:
1. Sender šalje `file_offer` (metadata + signature + timeout).
2. Receiver accept/reject.
3. Ako accept, chunk transfer kreće.
4. Chunkovi su enkriptirani, uz checksum/integritet provjere.
5. UI prima progress/completion/failure eventove.

Zaštite:
- rate limits po peeru i globalno
- max pending file ponuda
- silent rejection nakon abuse threshold-a
- filename/path traversal zaštita

---

### 8. DHT model podataka

Glavne kategorije DHT zapisa:

1. **Username registry**
   - by-name i by-peer mapiranje
   - potpisani payload
   - validator + selector + update pravila

2. **Direct offline stores**
   - bucket po paru korisnika
   - store-level i message-level potpisi
   - anti-stale `validateUpdate`

3. **Group offline stores**
   - sender bucketovi po group/key-version

4. **Group info records**
   - `latest` pointer
   - `versioned` state zapisi

Svi zapisi prolaze kroz mode-aware namespace i validator/selector sloj.

---

### 9. SQLite model (konceptualno)

Aplikacija koristi jedan DB file, ali s mode-aware skopiranjem gdje je bitno.

Najvažnije tablice:
- `users` (kontakt/public-key cache)
- `chats` (direct/group relationship source of truth)
- `messages`
- `encrypted_user_identities`
- `notifications`
- `chat_participants`
- `settings`
- `offline_sent_messages`
- `group_offline_sent_messages`
- `group_key_history`
- `group_offline_cursors`
- `group_pending_acks`
- `group_pending_info_publishes`
- `group_invite_delivery_acks`
- `group_sender_seq`, `group_member_seq`, `group_epoch_boundaries`
- `bootstrap_nodes`

Praktično pravilo: kontakt vidljivost i chat operacije trebaju se oslanjati na relationship/context (`chats` + participants), ne na globalni users cache samostalno.

---

### 10. Povezivost i infrastruktura

Desktop klijent može raditi s:

- **Bootstrap node** (`npm run bootstrap`)
  - mode-aware DHT protokol
  - validatori aktivni na bootstrapu

- **Relay node** (`npm run relay`)
  - Circuit Relay v2 server
  - rezervacije i limiti podesivi env varijablama

UI ima Connection Status dijalog s:
- pregledom bootstrap i relay node-ova
- add/remove node akcijama
- retry bootstrap / retry relay reservations
- mode-sensitive prikaz (npr. relay tab samo u fast modu)

---

### 11. UI i state management

Renderer koristi React + Redux.

Glavni state slice-ovi:
- `userSlice` (peerId, connected, username, registration state)
- `chatSlice` (chat list, poruke, pending key exchanges, contact attempts, file transfer state)

Event-driven sink iz main procesa:
- `onMessageReceived`
- `onChatCreated`
- `onKeyExchangeFailed`
- `onGroupChatActivated`
- `onGroupMembersUpdated`
- file transfer eventovi

Ovo omogućava da core ostane authoritative, a UI bude reaktivni prikaz stanja.

---

### 12. Sigurnosni model i odluke

1. **E2EE direct chat**
   - sesijski ključevi nakon key exchange-a
   - potpisani KX payload

2. **Offline zaštita**
   - poruke i store potpisi
   - validatori na DHT sloju

3. **Group integritet**
   - potpisane control poruke
   - ACK + republish za dostavu ključnih state update-a

4. **Pristupna kontrola**
   - blocked peers
   - connection gater pravila
   - contact mode (`active` / `silent` / `block`)

5. **Mode izolacija**
   - protokoli + DHT + pubsub + DB scoping

---

### 13. Pouzdanost i operativne strategije

Sustav ima više slojeva otpornosti:

- DHT status probing (ne oslanja se samo na “socket up”)
- retry mehanizmi za bootstrap/relay i republish queue-e
- single-flight zaštite u group offline check pathu
- per-bucket mutation lockovi za offline store update (izbjegavanje lost update problema)
- periodični cleanup i cache prune zadaci

---

### 14. Poznati tradeoff-i i granice

- Mode switch zahtijeva restart (namjerno u v1).
- Jedan SQLite file i dalje nosi kompleksnost mode-aware upita.
- Offline fallback je robustan, ali i dalje ovisi o DHT dostupnosti i propagation kvaliteti.
- Group control dostava je eventual-consistent model (ACK + republish + refetch), ne striktni instant consistency.

---

### 15. Preporučeni "AI handoff" tekst

Ako želiš brzo otvoriti novi AI chat, dovoljno je zalijepiti:

1. "Pročitaj `Kiyeovo_desktop_tehnicka_dokumentacija.md` kao source-of-truth arhitekture."
2. "Trenutno radim na [opis buga/featurea], u modu [fast/anonymous], i fokus je na [direct/group/file/offline]."
3. "Daj mi plan + minimalne promjene + rizike regresije."

---

### 16. Kratki rječnik

- **KX**: key exchange
- **DCUtR**: Direct Connection Upgrade through Relay
- **Bucket nudge**: lagani signal peeru da odradi refetch relevantnog offline bucketa
- **Group epoch**: verzija group ključa (`key_version`)
- **Pending ACK queues**: lokalni redovi poruka koje se periodički republishaju dok ne stigne ACK

---

### 17. Zaključak

Desktop verzija Kiyeovo je evoluirala iz CLI prototipa u složen, mode-aware P2P sustav s jasno razdvojenim runtime slojevima (UI, IPC, core), višestrukim fallback mehanizmima i ozbiljnim fokusom na sigurnost i pouzdanost. 

Za daljnji razvoj najvažnije je održavati konzistentnost mode izolacije, zadržati jednostavne i predvidive flowove u `MessageHandler`/group modulima, te dokumentirati svaku promjenu koja utječe na trust, identity i DHT semantiku.
