declare namespace Express {
  interface Request {
    auth?: {
      sessionId: string
      user: {
        id: string
        email: string | null
        name: string
        role: 'admin' | 'member'
        passwordSetupRequired: boolean
      }
    }
  }
}
