import 'dotenv/config'
import { Database } from 'arangojs'

const {
  ARANGO_URL = 'http://localhost:8529',
  ARANGO_USERNAME = 'root',
  ARANGO_PASSWORD = '',
  ARANGO_DATABASE = 'ecs_backend'
} = process.env

const db = new Database({
  url: ARANGO_URL,
  auth: { username: ARANGO_USERNAME, password: ARANGO_PASSWORD },
  databaseName: ARANGO_DATABASE
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
    
    // Switch to the database
    db.useDatabase(ARANGO_DATABASE)
    
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
      }
    ]
    
    for (const collection of collections) {
      try {
        await db.createCollection(collection.name, collection.options)
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
      }
    ]
    
    for (const index of indexes) {
      try {
        const collection = db.collection(index.collection)
        await collection.ensureIndex({
          type: index.type,
          fields: index.fields,
          unique: index.unique,
          sparse: index.sparse
        })
        console.log(`Index created on ${index.collection}.${index.fields.join(', ')}`)
      } catch (error) {
        if (error.errorNum === 1207) { // Index already exists
          console.log(`Index on ${index.collection}.${index.fields.join(', ')} already exists`)
        } else {
          console.warn(`Failed to create index on ${index.collection}.${index.fields.join(', ')}:`, error.message)
        }
      }
    }
    
    console.log('ArangoDB setup completed successfully!')
    
  } catch (error) {
    console.error('Error setting up ArangoDB:', error)
    process.exit(1)
  }
}

setupDatabase()
