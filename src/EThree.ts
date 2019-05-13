import PrivateKeyLoader from './PrivateKeyLoader';
import {
    CachingJwtProvider,
    KeyEntryAlreadyExistsError,
    CardManager,
    VirgilCardVerifier,
    IKeyEntryStorage,
    IAccessTokenProvider,
    KeyEntryStorage,
} from 'virgil-sdk';
import {
    VirgilPublicKey,
    Data,
    VirgilCrypto,
    VirgilCardCrypto,
    VirgilPrivateKey,
} from 'virgil-crypto/dist/virgil-crypto-pythia.es';
import {
    RegisterRequiredError,
    IdentityAlreadyExistsError,
    PrivateKeyAlreadyExistsError,
    MultipleCardsError,
    LookupNotFoundError,
    LookupError,
    DUPLICATE_IDENTITIES,
    EMPTY_ARRAY,
    throwIllegalInvocationError,
    IntegrityCheckFailedError,
} from './errors';
import { isArray, isString, isFile, isVirgilPublicKey } from './utils/typeguards';
import { withDefaults } from './utils/object';
import { getObjectValues, hasDuplicates } from './utils/array';
import { processFile, onChunkCallback } from './utils/processFile';
import {
    VIRGIL_STREAM_SIGNING_STATE,
    VIRGIL_STREAM_ENCRYPTING_STATE,
    VIRGIL_STREAM_DECRYPTING_STATE,
    VIRGIL_STREAM_VERIFYING_STATE,
} from './utils/constants';

export interface IEThreeInitOptions {
    /**
     * Implementation of IKeyEntryStorage. Used IndexedDB Key Storage from
     * [Virgil SDK](https://github.com/virgilsecurity/virgil-sdk-javascript) by default.
     */
    keyEntryStorage?: IKeyEntryStorage;
    /**
     * Url of the Card Services. Used for development purposes.
     */
    apiUrl?: string;
}
/**
 * @hidden
 */
export interface IEThreeCtorOptions extends IEThreeInitOptions {
    /**
     * Implementation of IAccessTokenProvider from [Virgil SDK](https://github.com/virgilsecurity/virgil-sdk-javascript);
     */
    accessTokenProvider: IAccessTokenProvider;
}

type KeyPair = {
    privateKey: VirgilPrivateKey;
    publicKey: VirgilPublicKey;
};

export type LookupResult = {
    [identity: string]: VirgilPublicKey;
};

export type onEncryptProgressSnapshot = {
    fileSize: number;
    bytesEncrypted: number;
    bytesSigned: number;
    state: VIRGIL_STREAM_SIGNING_STATE | VIRGIL_STREAM_ENCRYPTING_STATE;
};

export type onEncryptProgressCallback = (snapshot: onEncryptProgressSnapshot) => void;

export type onDecryptProgressSnapshot = {
    encryptedFileSize: number;
    fileSize?: number;
    bytesDecrypted: number;
    bytesVerified: number;
    state: VIRGIL_STREAM_DECRYPTING_STATE | VIRGIL_STREAM_VERIFYING_STATE;
};

export type onDecryptProgressCallback = (snapshot: onDecryptProgressSnapshot) => void;

export type encryptFileOpts = {
    chunkSize?: number;
    onProgress?: onEncryptProgressCallback;
};

export type decryptFileOpts = {
    chunkSize?: number;
    onProgress?: onDecryptProgressCallback;
};

export type onProcessCallback = (
    snapshot: {
        offset: number;
        chunk: string | ArrayBuffer;
        dataSize: number;
        endOffset: number;
    },
) => void;

type EncryptVirgilPublicKeyArg = LookupResult | VirgilPublicKey;

const _inProcess = Symbol('inProcess');
const _keyLoader = Symbol('keyLoader');
const STORAGE_NAME = '.virgil-local-storage';
const DEFAULT_API_URL = 'https://api.virgilsecurity.com';

export default class EThree {
    /**
     * Unique identifier of current user. Received from JWT token.
     */
    identity: string;
    /**
     * Instance of [VirgilCrypto](https://github.com/virgilsecurity/virgil-crypto-javascript).
     */
    virgilCrypto = new VirgilCrypto();
    /**
     * Instance of VirgilCardCrypto.
     */
    cardCrypto = new VirgilCardCrypto(this.virgilCrypto);
    /**
     * Instance of VirgilCardVerifier.
     */
    cardVerifier: VirgilCardVerifier;
    /**
     * Instance of CardManager. Used to create cards with user public keys.
     */
    cardManager: CardManager;
    /**
     * Instance of IAccessTokenProvider implementation. Using [[getToken]] to receive JWT.
     */
    accessTokenProvider: IAccessTokenProvider;
    /**
     * Instance of IKeyEntryStorage implementation. Used for storing private keys.
     */
    keyEntryStorage: IKeyEntryStorage;

    private [_keyLoader]: PrivateKeyLoader;
    private [_inProcess]: boolean = false;

    /**
     * Initialize a new instance of EThree which tied to specific user.
     * @param getToken - Function that receive JWT.
     */
    static async initialize(
        getToken: () => Promise<string>,
        options: IEThreeInitOptions = {},
    ): Promise<EThree> {
        const opts = withDefaults(options as IEThreeCtorOptions, {
            accessTokenProvider: new CachingJwtProvider(getToken),
        });
        const token = await opts.accessTokenProvider.getToken({ operation: 'get' });
        const identity = token.identity();
        return new EThree(identity, opts);
    }

    /**
     * @hidden
     * @param identity - Identity of the current user.
     */
    constructor(identity: string, options: IEThreeCtorOptions) {
        const opts = withDefaults(options, { apiUrl: DEFAULT_API_URL });
        this.identity = identity;
        this.accessTokenProvider = opts.accessTokenProvider;
        this.keyEntryStorage = opts.keyEntryStorage || new KeyEntryStorage(STORAGE_NAME);
        this.cardVerifier = new VirgilCardVerifier(this.cardCrypto, {
            verifySelfSignature: opts.apiUrl === DEFAULT_API_URL,
            verifyVirgilSignature: opts.apiUrl === DEFAULT_API_URL,
        });

        this[_keyLoader] = new PrivateKeyLoader(this.identity, {
            accessTokenProvider: this.accessTokenProvider,
            virgilCrypto: this.virgilCrypto,
            keyEntryStorage: this.keyEntryStorage,
            apiUrl: opts.apiUrl,
        });

        this.cardManager = new CardManager({
            cardCrypto: this.cardCrypto,
            cardVerifier: this.cardVerifier,
            accessTokenProvider: this.accessTokenProvider,
            retryOnUnauthorized: true,
            apiUrl: opts.apiUrl,
        });
    }

    /**
     * Register current user in Virgil Cloud. Saves private key locally and uploads public key to cloud.
     */
    async register() {
        if (this[_inProcess]) throwIllegalInvocationError('register');
        this[_inProcess] = true;
        try {
            const [cards, privateKey] = await Promise.all([
                this.cardManager.searchCards(this.identity),
                this[_keyLoader].loadLocalPrivateKey(),
            ]);
            if (cards.length > 1) throw new MultipleCardsError(this.identity);
            if (cards.length > 0) throw new IdentityAlreadyExistsError();
            if (privateKey && cards.length === 0) await this[_keyLoader].resetLocalPrivateKey();
            const keyPair = this.virgilCrypto.generateKeys();
            await this._publishCard(keyPair);
            await this[_keyLoader].savePrivateKeyLocal(keyPair.privateKey);
        } finally {
            this[_inProcess] = false;
        }
    }

    /**
     * Generates a new private key and saves locally. Replaces old public key with new one in Cloud.
     * Used in case if old private key is lost.
     */
    async rotatePrivateKey(): Promise<void> {
        if (this[_inProcess]) throwIllegalInvocationError('rotatePrivateKey');
        this[_inProcess] = true;
        try {
            const [cards, privateKey] = await Promise.all([
                this.cardManager.searchCards(this.identity),
                this[_keyLoader].loadLocalPrivateKey(),
            ]);
            if (cards.length === 0) throw new RegisterRequiredError();
            if (cards.length > 1) throw new MultipleCardsError(this.identity);
            if (privateKey) throw new PrivateKeyAlreadyExistsError();
            const keyPair = this.virgilCrypto.generateKeys();
            await this._publishCard(keyPair, cards[0].id);
            await this[_keyLoader].savePrivateKeyLocal(keyPair.privateKey);
        } finally {
            this[_inProcess] = false;
        }
    }

    /**
     * Downloads private key from Virgil Cloud. Use [[backupPrivateKey]] to upload the key first.
     * @param pwd User password for access to Virgil Keyknox Storage.
     */
    async restorePrivateKey(pwd: string): Promise<void> {
        try {
            await this[_keyLoader].restorePrivateKey(pwd);
        } catch (e) {
            if (e instanceof KeyEntryAlreadyExistsError) {
                throw new PrivateKeyAlreadyExistsError();
            }
            throw e;
        }
    }

    /**
     * Deletes local private key from key storage. Make sure [[backupPrivateKey]] method was called
     * first.
     */
    async cleanup() {
        await this[_keyLoader].resetLocalPrivateKey();
    }

    /**
     * Delete private key saved in Virgil Keyknox Storage.
     * @param pwd User password for access to Virgil Keyknox Storage. If password omitted resets all
     * Keyknox storage.
     */
    async resetPrivateKeyBackup(pwd?: string) {
        if (!pwd) return await this[_keyLoader].resetAll();
        return this[_keyLoader].resetPrivateKeyBackup(pwd);
    }

    /**
     * Encrypts data for recipient(s) public key(s). If there is no recipient and message encrypted
     * for the current user, omit public key.
     */
    async encrypt(
        message: ArrayBuffer,
        publicKey?: EncryptVirgilPublicKeyArg,
    ): Promise<ArrayBuffer>;
    async encrypt(message: string, publicKeys?: EncryptVirgilPublicKeyArg): Promise<string>;
    async encrypt(message: Buffer, publicKey?: EncryptVirgilPublicKeyArg): Promise<Buffer>;
    async encrypt(message: Data, publicKeys?: EncryptVirgilPublicKeyArg): Promise<Data> {
        const isMessageString = isString(message);

        const privateKey = await this[_keyLoader].loadLocalPrivateKey();
        if (!privateKey) throw new RegisterRequiredError();

        const publicKeysArray = this._addOwnPublicKey(privateKey, publicKeys);

        const res: Data = this.virgilCrypto.signThenEncrypt(message, privateKey, publicKeysArray);
        if (isMessageString) return res.toString('base64');
        return res;
    }

    /**
     * Decrypts data and verify signature of sender by his public key. If message is self-encrypted,
     * omit public key parameter.
     */
    async decrypt(message: string, publicKey?: VirgilPublicKey): Promise<string>;
    async decrypt(message: Buffer, publicKey?: VirgilPublicKey): Promise<Buffer>;
    async decrypt(message: ArrayBuffer, publicKey?: VirgilPublicKey): Promise<Buffer>;
    async decrypt(message: Data, publicKey?: VirgilPublicKey): Promise<Data> {
        const isMessageString = isString(message);

        const privateKey = await this[_keyLoader].loadLocalPrivateKey();
        if (!privateKey) throw new RegisterRequiredError();
        if (!publicKey) publicKey = this.virgilCrypto.extractPublicKey(privateKey);

        const res: Data = this.virgilCrypto.decryptThenVerify(message, privateKey, publicKey);
        if (isMessageString) return res.toString('utf8') as string;
        return res as Buffer;
    }

    async encryptFile(
        file: File | Blob,
        publicKeys?: EncryptVirgilPublicKeyArg,
        options: encryptFileOpts = {},
    ): Promise<File | Blob> {
        const chunkSize = options.chunkSize ? options.chunkSize : 64 * 1024;
        const fileSize = file.size;

        const privateKey = await this[_keyLoader].loadLocalPrivateKey();
        if (!privateKey) throw new RegisterRequiredError();

        const publicKeysArray = this._addOwnPublicKey(privateKey, publicKeys);

        const streamSigner = this.virgilCrypto.createStreamSigner();

        const signaturePromise = new Promise<Buffer>((resolve, reject) => {
            const onFileProcess = (chunk: string | ArrayBuffer, offset: number) => {
                if (options.onProgress) {
                    options.onProgress({
                        state: VIRGIL_STREAM_SIGNING_STATE,
                        bytesSigned: offset,
                        bytesEncrypted: 0,
                        fileSize: fileSize,
                    });
                }
                streamSigner.update(chunk);
            };
            const onFinish = () => resolve(streamSigner.sign(privateKey));
            processFile(file, chunkSize, onFileProcess, onFinish, reject);
        });

        const streamCipher = this.virgilCrypto.createStreamCipher(
            publicKeysArray,
            await signaturePromise,
        );

        const encryptedChunksPromise = new Promise<Buffer[]>((resolve, reject) => {
            const encryptedChunks: Buffer[] = [];
            encryptedChunks.push(streamCipher.start());

            const onFileProcess = (chunk: string | ArrayBuffer, offset: number) => {
                encryptedChunks.push(streamCipher.update(chunk));
                if (options.onProgress) {
                    options.onProgress({
                        state: VIRGIL_STREAM_ENCRYPTING_STATE,
                        bytesSigned: fileSize,
                        bytesEncrypted: offset,
                        fileSize: fileSize,
                    });
                }
            };

            const onFinish = () => {
                encryptedChunks.push(streamCipher.final());
                resolve(encryptedChunks);
            };

            processFile(file, chunkSize, onFileProcess, onFinish, reject);
        });

        const encryptedChunks = await encryptedChunksPromise;
        if (isFile(file)) return new File(encryptedChunks, file.name, { type: file.type });
        return new Blob(encryptedChunks, { type: file.type });
    }

    async decryptFile(
        file: File | Blob,
        publicKey?: VirgilPublicKey,
        options: decryptFileOpts = {},
    ): Promise<File | Blob> {
        const fileSize = file.size;
        const chunkSize = options.chunkSize ? options.chunkSize : 64 * 1024;

        const privateKey = await this[_keyLoader].loadLocalPrivateKey();
        if (!privateKey) throw new RegisterRequiredError();
        if (!publicKey) publicKey = this.virgilCrypto.extractPublicKey(privateKey);

        const streamDecipher = this.virgilCrypto.createStreamDecipher(privateKey);

        type decryptStreamResult = { signature: Buffer; decryptedChunks: Buffer[] };
        const decryptedChunksPromise = new Promise<decryptStreamResult>((resolve, reject) => {
            const decryptedChunks: Buffer[] = [];

            const onFileProcess = (chunk: string | ArrayBuffer, offset: number) => {
                decryptedChunks.push(streamDecipher.update(chunk));
                if (options.onProgress) {
                    options.onProgress({
                        state: VIRGIL_STREAM_DECRYPTING_STATE,
                        bytesDecrypted: offset,
                        bytesVerified: 0,
                        encryptedFileSize: fileSize,
                    });
                }
            };

            const onFinish = () => {
                decryptedChunks.push(streamDecipher.final(false));
                const signature = streamDecipher.getSignature();
                if (!signature) throw new IntegrityCheckFailedError('Signature not present.');
                streamDecipher.dispose();
                resolve({ decryptedChunks, signature });
            };

            processFile(file, chunkSize, onFileProcess, onFinish, reject);
        });

        const { decryptedChunks, signature } = await decryptedChunksPromise;
        const streamVerifier = this.virgilCrypto.createStreamVerifier(signature, 'utf8');

        let decryptedFile: File | Blob;
        if (isFile(file)) decryptedFile = new File(decryptedChunks, file.name, { type: file.type });
        decryptedFile = new Blob(decryptedChunks, { type: file.type });
        const decryptedFileSize = decryptedFile.size;

        const verifyPromise = new Promise<boolean>((resolve, reject) => {
            const onFileProcess: onChunkCallback = (chunk, offset) => {
                streamVerifier.update(chunk);
                if (options.onProgress) {
                    options.onProgress({
                        state: VIRGIL_STREAM_VERIFYING_STATE,
                        encryptedFileSize: fileSize,
                        bytesDecrypted: fileSize,
                        bytesVerified: offset,
                        fileSize: decryptedFileSize,
                    });
                }
            };

            const onFinish = () => resolve(streamVerifier.verify(publicKey!));

            processFile(decryptedFile, chunkSize, onFileProcess, onFinish, reject);
        });

        const isVerified = await verifyPromise;

        if (!isVerified) {
            throw new IntegrityCheckFailedError('Signature verification has failed.');
        }

        return decryptedFile;
    }

    /**
     * Find public keys for user identities registered on Virgil Cloud.
     */
    async lookupPublicKeys(identity: string): Promise<VirgilPublicKey>;
    async lookupPublicKeys(identities: string[]): Promise<LookupResult>;
    async lookupPublicKeys(identities: string[] | string): Promise<LookupResult | VirgilPublicKey> {
        const argument = isArray(identities) ? identities : [identities];
        if (argument.length === 0) throw new Error(EMPTY_ARRAY);
        if (hasDuplicates(argument)) throw new Error(DUPLICATE_IDENTITIES);

        const cards = await this.cardManager.searchCards(argument);

        let result: LookupResult = {},
            resultWithErrors: { [identity: string]: Error } = {};

        for (let identity of argument) {
            const filteredCards = cards.filter(card => card.identity === identity);
            if (filteredCards.length === 0) {
                resultWithErrors[identity] = new LookupNotFoundError(identity);
            } else if (filteredCards.length > 1) {
                resultWithErrors[identity] = new MultipleCardsError(identity);
            } else {
                result[identity] = filteredCards[0].publicKey as VirgilPublicKey;
            }
        }

        if (getObjectValues(resultWithErrors).length !== 0) {
            throw new LookupError({ ...resultWithErrors, ...result });
        }

        if (Array.isArray(identities)) return result;

        return result[identities];
    }

    /**
     * Changes password for access to current user private key backup.
     * @param oldPwd users old password
     * @param newPwd users new password
     */
    async changePassword(oldPwd: string, newPwd: string) {
        return await this[_keyLoader].changePassword(oldPwd, newPwd);
    }

    /**
     * Uploads current user private key to Virgil Keyknox Storage.
     */
    async backupPrivateKey(pwd: string): Promise<void> {
        const privateKey = await this[_keyLoader].loadLocalPrivateKey();
        if (!privateKey) throw new RegisterRequiredError();
        await this[_keyLoader].savePrivateKeyRemote(privateKey, pwd);
        return;
    }

    /**
     * Checks if current user has private key saved locally.
     */
    hasLocalPrivateKey(): Promise<Boolean> {
        return this[_keyLoader].hasPrivateKey();
    }

    private async _publishCard(keyPair: KeyPair, previousCardId?: string) {
        const card = await this.cardManager.publishCard({
            privateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey,
            previousCardId,
        });

        return { keyPair, card };
    }

    private _isOwnPublicKeysIncluded(ownPublicKey: VirgilPublicKey, publicKeys: VirgilPublicKey[]) {
        const selfPublicKey = this.virgilCrypto.exportPublicKey(ownPublicKey).toString('base64');

        const stringKeys = publicKeys.map(key =>
            this.virgilCrypto.exportPublicKey(key).toString('base64'),
        );
        return stringKeys.some((key, i) => key === selfPublicKey);
    }

    private _addOwnPublicKey(privateKey: VirgilPrivateKey, publicKeys?: EncryptVirgilPublicKeyArg) {
        let argument: VirgilPublicKey[];

        if (publicKeys == null) argument = [];
        else if (isVirgilPublicKey(publicKeys)) argument = [publicKeys];
        else argument = getObjectValues(publicKeys) as VirgilPublicKey[];

        const ownPublicKey = this.virgilCrypto.extractPublicKey(privateKey);

        if (!this._isOwnPublicKeysIncluded(ownPublicKey, argument)) {
            argument.push(ownPublicKey);
        }
        return argument;
    }
}
