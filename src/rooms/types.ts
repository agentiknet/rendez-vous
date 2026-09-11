export type Tier = "messenger" | "email" | "room-web"

export interface Address {
  provider: string
  source: string
  contactRef: string
}

export interface Member {
  id: string
  displayName: string
  tier: Tier
  address: Address
  joinedAt: string
}

export interface Room {
  code: string
  sessionId: string | undefined
  sandboxId: string | undefined
  artifactUrl: string | undefined
  members: Member[]
  createdAt: string
  updatedAt: string
  cursor: number
}
