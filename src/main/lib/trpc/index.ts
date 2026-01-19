import { initTRPC } from "@trpc/server"
import { BrowserWindow } from "electron"
import superjson from "superjson"

/**
 * Context passed to all tRPC procedures
 */
export interface Context {
  getWindow: () => BrowserWindow | null
}

/**
 * Initialize tRPC with context and superjson transformer
 */
const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      },
    }
  },
})

/**
 * Export reusable router and procedure helpers
 */
export const router = t.router
export const publicProcedure = t.procedure
export const middleware = t.middleware

/**
 * Middleware to log procedure calls (disabled in production)
 */
export const loggerMiddleware = middleware(async ({ next }) => {
  return await next()
})

/**
 * Procedure with logging
 */
export const loggedProcedure = publicProcedure.use(loggerMiddleware)
