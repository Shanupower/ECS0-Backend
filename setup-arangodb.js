import 'dotenv/config'
import { Database } from 'arangojs'

const {
  ARANGO_URL = 'http://localhost:8529',
  ARANGO_USERNAME = 'root',
  ARANGO_PASSWORD = '',
  ARANGO_DATABASE = 'ecs_backend'
} = process.env

// Connect to system database first to create our database
const db = new Database({
  url: ARANGO_URL,
  auth: { username: ARANGO_USERNAME, password: ARANGO_PASSWORD },
  databaseName: '_system'  // Connect to system database first
})

async function setupDatabase() {
  try {
    console.log('Setting up ArangoDB database...')
    
    // Create database if it doesn't exist
    try {
      await db.createDatabase(ARANGO_DATABASE)
      console.log(`Database '${ARANGO_DATABASE}' created successfully`)
    } catch (error) {
      if (error.errorNum === 1207) { // Database already exists
        console.log(`Database '${ARANGO_DATABASE}' already exists`)
      } else {
        throw error
      }
    }
    
    // Create a new connection to our database
    const appDb = new Database({
      url: ARANGO_URL,
      auth: { username: ARANGO_USERNAME, password: ARANGO_PASSWORD },
      databaseName: ARANGO_DATABASE
    })
    
    // Create collections
    const collections = [
      {
        name: 'users',
        options: {
          keyOptions: { type: 'autoincrement' }
        }
      },
      {
        name: 'customers',
        options: {
          keyOptions: { type: 'autoincrement' }
        }
      },
      {
        name: 'receipts',
        options: {
          keyOptions: { type: 'autoincrement' }
        }
      },
      {
        name: 'branches',
        options: {
          keyOptions: { type: 'autoincrement' }
        }
      },
      {
        name: 'issues',
        options: {
          keyOptions: { type: 'autoincrement' }
        }
      },
      {
        name: 'fd_issuers',
        options: {
          keyOptions: { type: 'traditional' }
        }
      },
      {
        name: 'amcs',
        options: {
          keyOptions: { type: 'traditional' }
        }
      },
      {
        name: 'mf_schemes',
        options: {
          keyOptions: { type: 'autoincrement' }
        }
      }
    ]
    
    for (const collection of collections) {
      try {
        await appDb.createCollection(collection.name, collection.options)
        console.log(`Collection '${collection.name}' created successfully`)
      } catch (error) {
        if (error.errorNum === 1207) { // Collection already exists
          console.log(`Collection '${collection.name}' already exists`)
        } else {
          throw error
        }
      }
    }
    
    // Create indexes for better performance
    const indexes = [
      {
        collection: 'users',
        type: 'persistent',
        fields: ['emp_code'],
        unique: true
      },
      {
        collection: 'users',
        type: 'persistent',
        fields: ['is_active']
      },
      {
        collection: 'customers',
        type: 'persistent',
        fields: ['investor_id'],
        unique: true
      },
      {
        collection: 'customers',
        type: 'persistent',
        fields: ['pan'],
        unique: true,
        sparse: true
      },
      // Enhanced search indexes for customers
      {
        collection: 'customers',
        type: 'persistent',
        fields: ['name']
      },
      {
        collection: 'customers',
        type: 'persistent',
        fields: ['email'],
        sparse: true
      },
      {
        collection: 'customers',
        type: 'persistent',
        fields: ['mobile'],
        sparse: true
      },
      {
        collection: 'customers',
        type: 'persistent',
        fields: ['relationship_manager']
      },
      {
        collection: 'customers',
        type: 'persistent',
        fields: ['city'],
        sparse: true
      },
      {
        collection: 'customers',
        type: 'persistent',
        fields: ['state'],
        sparse: true
      },
      {
        collection: 'customers',
        type: 'persistent',
        fields: ['created_at']
      },
      {
        collection: 'customers',
        type: 'persistent',
        fields: ['is_active']
      },
      // Text index for full-text search on customer fields
      {
        collection: 'customers',
        type: 'fulltext',
        fields: ['name'],
        minLength: 2
      },
      {
        collection: 'receipts',
        type: 'persistent',
        fields: ['user_id']
      },
      {
        collection: 'receipts',
        type: 'persistent',
        fields: ['emp_code']
      },
      {
        collection: 'receipts',
        type: 'persistent',
        fields: ['investor_id']
      },
      {
        collection: 'receipts',
        type: 'persistent',
        fields: ['date']
      },
      {
        collection: 'receipts',
        type: 'persistent',
        fields: ['is_deleted']
      },
      {
        collection: 'receipts',
        type: 'persistent',
        fields: ['product_category']
      },
      {
        collection: 'branches',
        type: 'persistent',
        fields: ['branch_name'],
        unique: true
      },
      {
        collection: 'branches',
        type: 'persistent',
        fields: ['is_active']
      },
      {
        collection: 'issues',
        type: 'persistent',
        fields: ['id'],
        unique: true
      },
      {
        collection: 'issues',
        type: 'persistent',
        fields: ['created_by']
      },
      {
        collection: 'issues',
        type: 'persistent',
        fields: ['status']
      },
      {
        collection: 'issues',
        type: 'persistent',
        fields: ['created_at']
      }
    ]
    
    for (const index of indexes) {
      try {
        const collection = appDb.collection(index.collection)
        const indexOptions = {
          type: index.type,
          fields: index.fields,
          unique: index.unique,
          sparse: index.sparse
        }
        
        // Add fulltext-specific options
        if (index.type === 'fulltext') {
          indexOptions.minLength = index.minLength || 2
        }
        
        await collection.ensureIndex(indexOptions)
        console.log(`${index.type} index created on ${index.collection}.${index.fields.join(', ')}`)
      } catch (error) {
        if (error.errorNum === 1207) { // Index already exists
          console.log(`Index on ${index.collection}.${index.fields.join(', ')} already exists`)
        } else {
          console.warn(`Failed to create index on ${index.collection}.${index.fields.join(', ')}:`, error.message)
        }
      }
    }
    
    // Add schema validation for fd_issuers
    const fdIssuersSchema = {
      "type": "object",
      "required": ["legal_name", "short_name", "type", "min_deposit_amount", "premature_withdrawal_policy", "is_active", "schemes"],
      "additionalProperties": false,
      "properties": {
        "_key": { "type": "string", "pattern": "^[a-z0-9_\\-]+$" },
        "legal_name": { "type": "string", "minLength": 3 },
        "short_name": { "type": "string", "minLength": 2 },
        "type": { "type": "string", "enum": ["NBFC", "Bank", "Corporate FD"] },
        "credit_rating_agency": { "type": ["string", "null"], "minLength": 1 },
        "credit_rating": { "type": ["string", "null"], "minLength": 1 },
        "min_deposit_amount": { "type": "number", "minimum": 1 },
        "max_deposit_amount": { "type": ["number", "null"], "minimum": 1 },
        "premature_withdrawal_policy": { "type": "string", "minLength": 5 },
        "notes_compliance": { "type": ["string", "null"] },
        "is_active": { "type": "boolean" },
        "schemes": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "required": ["scheme_id", "scheme_name", "is_cumulative", "payout_frequency_type", "lock_in_months", "premature_allowed", "min_tenure_months", "max_tenure_months", "senior_citizen_bonus_bps", "women_bonus_bps", "renewal_bonus_bps", "tds_applicable", "show_form15g15h_option", "is_active", "rate_slabs"],
            "additionalProperties": false,
            "properties": {
              "scheme_id": { "type": "string", "pattern": "^[A-Z0-9_\\-]+$", "minLength": 3 },
              "scheme_name": { "type": "string", "minLength": 3 },
              "description_short": { "type": ["string", "null"], "minLength": 3 },
              "is_cumulative": { "type": "boolean" },
              "payout_frequency_type": {
                "type": "array",
                "minItems": 1,
                "uniqueItems": true,
                "items": { "type": "string", "enum": ["Monthly", "Quarterly", "Half-Yearly", "Yearly", "On Maturity"] }
              },
              "lock_in_months": { "type": "number", "minimum": 0, "multipleOf": 1 },
              "premature_allowed": { "type": "boolean" },
              "premature_terms": { "type": ["string", "null"] },
              "min_tenure_months": { "type": "number", "minimum": 1, "multipleOf": 1 },
              "max_tenure_months": { "type": "number", "minimum": 1, "multipleOf": 1 },
              "min_amount": { "type": ["number", "null"], "minimum": 1 },
              "max_amount": { "type": ["number", "null"], "minimum": 1 },
              "senior_citizen_bonus_bps": { "type": "number", "minimum": 0, "multipleOf": 1 },
              "women_bonus_bps": { "type": "number", "minimum": 0, "multipleOf": 1 },
              "renewal_bonus_bps": { "type": "number", "minimum": 0, "multipleOf": 1 },
              "tds_applicable": { "type": "boolean" },
              "show_form15g15h_option": { "type": "boolean" },
              "is_active": { "type": "boolean" },
              "rate_slabs": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "type": "object",
                  "required": ["slab_id", "tenure_min_months", "tenure_max_months", "payout_frequency_type", "base_interest_rate_pa", "is_active"],
                  "additionalProperties": false,
                  "properties": {
                    "slab_id": { "type": "string", "pattern": "^[a-zA-Z0-9_\\-]+$", "minLength": 3 },
                    "tenure_min_months": { "type": "number", "minimum": 1, "multipleOf": 1 },
                    "tenure_max_months": { "type": "number", "minimum": 1, "multipleOf": 1 },
                    "payout_frequency_type": { "type": "string", "enum": ["Monthly", "Quarterly", "Half-Yearly", "Yearly", "On Maturity"] },
                    "base_interest_rate_pa": { "type": "number", "minimum": 0, "maximum": 30, "multipleOf": 0.01 },
                    "compounding_frequency": { "type": ["string", "null"], "enum": ["Quarterly", "Half-Yearly", "Yearly", null] },
                    "effective_yield_pa": { "type": ["number", "null"], "minimum": 0, "maximum": 30, "multipleOf": 0.01 },
                    "notes_public_display": { "type": ["string", "null"] },
                    "is_active": { "type": "boolean" }
                  }
                }
              }
            }
          }
        }
      }
    }
    
    try {
      const fdIssuersCollection = appDb.collection('fd_issuers')
      await fdIssuersCollection.save({ schema: fdIssuersSchema, level: 'moderate' })
      console.log('Schema validation added to fd_issuers collection')
    } catch (error) {
      console.warn('Could not add schema validation to fd_issuers:', error.message)
    }
    
    console.log('ArangoDB setup completed successfully!')
    
  } catch (error) {
    console.error('Error setting up ArangoDB:', error)
    process.exit(1)
  }
}

setupDatabase()
