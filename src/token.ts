import { createHash, randomBytes } from 'node:crypto'

// 32 random bytes, URL-safe (43 characters). Only its hash is ever stored.
export const mintToken = (): string => randomBytes(32).toString('base64url')

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')
