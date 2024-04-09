import sodium from 'libsodium-wrappers-sumo';
import axios, { AxiosResponse } from 'axios';
import { v4 as uuidv4 } from 'uuid';


const DEFAULT_PROTOCOL = 'https';
const DEFAULT_HOST = 'iam.mtaylor.io';
const DEFAULT_PORT = null;


interface User {
  id: string,
  email: string | null,
  groups: string[],
  policies: string[],
  publicKeys: { description: string, key: string }[],
}


interface Group {
  id: string,
  name: string | null,
  users: string[],
  policies: string[],
}


export class Principal {
  public readonly user: User;
  public readonly publicKey: Uint8Array;
  private privateKey: Uint8Array;

  constructor(user: User, privateKey: Uint8Array, publicKey: Uint8Array | null = null) {
    this.user = user;
    this.privateKey = privateKey;
    this.publicKey = publicKey ?
      publicKey : sodium.crypto_sign_ed25519_sk_to_pk(privateKey);
  }

  async client(
    protocol: string = DEFAULT_PROTOCOL,
    host: string = DEFAULT_HOST,
    port: number | null = DEFAULT_PORT,
  ): Promise<IAM> {
    return await IAM.client(this.user.id, this.privateKey, protocol, host, port);
  }
}


export default class IAM {
  private protocol: string;
  private host: string;
  private port: number | null;
  private userId: string;
  private secretKey: Uint8Array;
  private publicKey: Uint8Array;

  constructor(
    userId: string,
    secretKey: Uint8Array | string,
    protocol: string,
    host: string,
    port: number | null
  ) {
    const secretKeyBytes = typeof secretKey === 'string' ?
      sodium.from_base64(secretKey, sodium.base64_variants.ORIGINAL) : secretKey;

    this.protocol = protocol;
    this.host = host;
    this.port = port;
    this.userId = userId;
    this.secretKey = secretKeyBytes;
    this.publicKey = sodium.crypto_sign_ed25519_sk_to_pk(secretKeyBytes);
  }

  static async client(
    userId: string,
    secretKey: Uint8Array | string,
    protocol: string = DEFAULT_PROTOCOL,
    host: string = DEFAULT_HOST,
    port: number | null = DEFAULT_PORT,
  ): Promise<IAM> {
    await sodium.ready; // Wait for libsodium to be ready
    return new IAM(userId, secretKey, protocol, host, port);
  }

  async request(
    method: string,
    path: string,
    query: string | null = null,
    body: any | null = null,
  ): Promise<AxiosResponse> {
    const url = this.url(path, query);
    const requestId = uuidv4();
    const publicKey = sodium.to_base64(this.publicKey, sodium.base64_variants.ORIGINAL);
    const signature = this.signature(requestId, method, path, query);

    const headers = {
      'Authorization': `Signature ${signature}`,
      'X-MTaylor-IO-User-ID': this.userId,
      'X-MTaylor-IO-Request-ID': requestId,
      'X-MTaylor-IO-Public-Key': publicKey,
    };

    const response = await axios.request({
      method,
      url,
      headers,
      data: body,
    });

    return response;
  }

  signature(
    requestId: string,
    method: string,
    path: string,
    query: string | null = null,
  ): string {
    return sodium.to_base64(sodium.crypto_sign_detached(
      requestStringToSign(method, this.host, path, query, requestId),
      this.secretKey,
    ), sodium.base64_variants.ORIGINAL);
  }

  url(path: string, query: string | null = null): string {
    return [
      this.protocol,
      '://',
      this.host,
      this.port ? `:${this.port}` : '',
      path,
      query ? query : '',
    ].join('');
  }
}


export class Users {
  private iam: IAM;

  constructor(iam: IAM) {
    this.iam = iam;
  }

  async createUser(
    email: string | null = null,
    groups: string[] = [],
    policies: string[] = [],
  ): Promise<Principal> {
    const keypair = sodium.crypto_sign_keypair();

    const publicKeys = [{
      'description': 'default',
      'key': sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL),
    }]

    const id = uuidv4();
    const user = { id, email, groups, policies, publicKeys };

    const response = await this.iam.request('POST', '/users', null, user);

    return new Principal(response.data, keypair.privateKey, keypair.publicKey);
  }

  async deleteUser(id: string): Promise<void> {
    await this.iam.request('DELETE', `/users/${id}`);
  }

  async getUser(id: string): Promise<User> {
    const response = await this.iam.request('GET', `/users/${id}`);
    return response.data;
  }

  async listUsers(offset: number = 0, limit: number = 100): Promise<User[]> {
    const query = `?offset=${offset}&limit=${limit}`;
    const response = await this.iam.request('GET', '/users', query)
    return response.data;
  }
}


export class Groups {
  private iam: IAM;

  constructor(iam: IAM) {
    this.iam = iam;
  }

  async createGroup(
    name: string | null = null,
    users: string[] = [],
    policies: string[] = [],
  ): Promise<Group> {
    const id = uuidv4();
    const group = { id, name, users, policies };
    const response = await this.iam.request('POST', '/groups', null, group);
    return response.data;
  }

  async deleteGroup(id: string): Promise<void> {
    await this.iam.request('DELETE', `/groups/${id}`);
  }

  async getGroup(id: string): Promise<Group> {
    const response = await this.iam.request('GET', `/groups/${id}`);
    return response.data;
  }

  async listGroups(offset: number = 0, limit: number = 100): Promise<Group[]> {
    const query = `?offset=${offset}&limit=${limit}`;
    const response = await this.iam.request('GET', '/groups', query)
    return response.data;
  }
}


function requestStringToSign(
  method: string,
  host: string,
  path: string,
  query: string | null,
  requestId: string | null,
): Uint8Array {
  const s = [
    method,
    host,
    path,
    query ? query : '',
    requestId,
  ].join('\n')
  return sodium.from_string(s);
}
