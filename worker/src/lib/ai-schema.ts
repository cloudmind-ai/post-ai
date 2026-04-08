/**
 * AI Schema Service - Natural language to PostgreSQL DDL conversion
 *
 * Uses @g-a-l-a-c-t-i-c/ai to generate schemas, migrations, and query optimizations
 * from natural language descriptions.
 */

import type { Ai } from '@cloudflare/workers-types'

export interface MigrationScripts {
  up: string
  down: string
  warnings?: string[]
}

export interface QueryOptimization {
  optimized: string
  explanation: string
  originalIssues?: string[]
  indexRecommendations?: string[]
}

export interface AISchemaService {
  generateSchemaFromDescription(description: string): Promise<string>
  generateMigrationFromDescription(
    currentSchema: string,
    changeRequest: string
  ): Promise<MigrationScripts>
  optimizeQuery(query: string): Promise<QueryOptimization>
}

const SYSTEM_PROMPT_SCHEMA = `You are an expert PostgreSQL database designer.
Your task is to convert natural language descriptions into valid PostgreSQL DDL statements.

Rules:
- Generate only CREATE TABLE statements with appropriate data types
- Use UUID for primary keys with gen_random_uuid() as default
- Include created_at and updated_at TIMESTAMP columns when appropriate
- Add appropriate constraints (NOT NULL, UNIQUE, CHECK)
- Use PostgreSQL best practices for indexing and constraints
- Return ONLY the DDL statement, no markdown formatting, no explanations

Example:
Input: "Create a users table with email and name"
Output: CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email VARCHAR(255) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT NOW());`

const SYSTEM_PROMPT_MIGRATION = `You are an expert PostgreSQL migration developer.
Your task is to generate safe database migration scripts from change requests.

Rules:
- Generate SQL that is safe to run in production
- Always provide both "up" (forward) and "down" (rollback) scripts
- For destructive changes (DROP COLUMN, DROP TABLE), add warnings about data loss
- Use transactions where appropriate for atomicity
- Return JSON format: { "up": "...", "down": "...", "warnings": [...] }
- Warnings array is optional, include only for destructive operations

Example:
Input: "Add phone column to users table"
Output: {"up": "ALTER TABLE users ADD COLUMN phone VARCHAR(20);", "down": "ALTER TABLE users DROP COLUMN phone;"}`

const SYSTEM_PROMPT_OPTIMIZE = `You are an expert PostgreSQL query optimizer.
Your task is to analyze SQL queries and suggest optimizations.

Rules:
- Identify performance issues (missing indexes, inefficient patterns)
- Provide an optimized version of the query
- Explain the reasoning in clear terms
- Suggest index creation when beneficial
- Return JSON format: { "optimized": "...", "explanation": "...", "originalIssues": [...], "indexRecommendations": [...] }
- All array fields are optional

Focus on:
- Index usage and seek operations
- Avoiding sequential scans
- Proper use of joins
- Parameterized queries vs string interpolation
- Case-insensitive searches (ILIKE prevents index usage)`

/**
 * Create an AI Schema Service instance
 */
export function createAISchemaService(ai: Ai): AISchemaService {
  return {
    async generateSchemaFromDescription(description: string): Promise<string> {
      try {
        const result = await ai.run('@hf/nousresearch/hermes-2-pro-mistral-7b', {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT_SCHEMA },
            { role: 'user', content: description },
          ],
          max_tokens: 1000,
          temperature: 0.1,
        })

        if (typeof result === 'object' && result !== null && 'response' in result) {
          return (result as { response: string }).response.trim()
        }

        throw new Error('Unexpected AI response format')
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        throw new Error(`Failed to generate schema: ${errorMessage}`)
      }
    },

    async generateMigrationFromDescription(
      currentSchema: string,
      changeRequest: string
    ): Promise<MigrationScripts> {
      try {
        const prompt = `Current schema:\n${currentSchema}\n\nChange request: ${changeRequest}`

        const result = await ai.run('@hf/nousresearch/hermes-2-pro-mistral-7b', {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT_MIGRATION },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1000,
          temperature: 0.1,
        })

        if (typeof result === 'object' && result !== null && 'response' in result) {
          const parsed = JSON.parse((result as { response: string }).response)

          if (!parsed.up || !parsed.down) {
            throw new Error('Migration response missing up or down script')
          }

          return {
            up: parsed.up,
            down: parsed.down,
            warnings: parsed.warnings,
          }
        }

        throw new Error('Unexpected AI response format')
      } catch (error) {
        if (error instanceof Error && error.message.includes('Failed to')) {
          throw error
        }
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        throw new Error(`Failed to generate migration: ${errorMessage}`)
      }
    },

    async optimizeQuery(query: string): Promise<QueryOptimization> {
      try {
        const result = await ai.run('@hf/nousresearch/hermes-2-pro-mistral-7b', {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT_OPTIMIZE },
            { role: 'user', content: query },
          ],
          max_tokens: 1000,
          temperature: 0.1,
        })

        if (typeof result === 'object' && result !== null && 'response' in result) {
          const parsed = JSON.parse((result as { response: string }).response)

          if (!parsed.optimized || !parsed.explanation) {
            throw new Error('Optimization response missing required fields')
          }

          return {
            optimized: parsed.optimized,
            explanation: parsed.explanation,
            originalIssues: parsed.originalIssues,
            indexRecommendations: parsed.indexRecommendations,
          }
        }

        throw new Error('Unexpected AI response format')
      } catch (error) {
        if (error instanceof Error && error.message.includes('Failed to')) {
          throw error
        }
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        throw new Error(`Failed to optimize query: ${errorMessage}`)
      }
    },
  }
}

// Default export for convenience - requires AI binding
export function generateSchemaFromDescription(
  ai: Ai,
  description: string
): Promise<string> {
  return createAISchemaService(ai).generateSchemaFromDescription(description)
}

export function generateMigrationFromDescription(
  ai: Ai,
  currentSchema: string,
  changeRequest: string
): Promise<MigrationScripts> {
  return createAISchemaService(ai).generateMigrationFromDescription(
    currentSchema,
    changeRequest
  )
}

export function optimizeQuery(ai: Ai, query: string): Promise<QueryOptimization> {
  return createAISchemaService(ai).optimizeQuery(query)
}
