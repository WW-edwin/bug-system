declare namespace Express {
  interface Request {
    auth?: {
      sessionId: string
      user: {
        id: string
        email: string
        name: string
        role: 'admin' | 'member'
      }
    }
  }
}
