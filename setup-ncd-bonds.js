import 'dotenv/config'
import { Database } from 'arangojs'

const {
  ARANGO_URL = 'https://db.ecsfinancial.tech',
  ARANGO_USERNAME = 'root',
  ARANGO_PASSWORD = '',
  ARANGO_DATABASE = 'ecs_backend'
} = process.env

async function setupNCDBonds() {
  try {
    console.log('Setting up NCD/Bond collections in production database...')
    console.log(`Connecting to: ${ARANGO_URL}/${ARANGO_DATABASE}`)
    
    const appDb = new Database({
      url: ARANGO_URL,
      auth: { username: ARANGO_USERNAME, password: ARANGO_PASSWORD },
      databaseName: ARANGO_DATABASE
    })
    
    // Create ncd_bond_issuers collection
    try {
      await appDb.createCollection('ncd_bond_issuers', {
        keyOptions: { type: 'traditional' }
      })
      console.log("Collection 'ncd_bond_issuers' created successfully")
    } catch (error) {
      if (error.errorNum === 1207) { // Collection already exists
        console.log("Collection 'ncd_bond_issuers' already exists")
      } else {
        throw error
      }
    }
    
    // Create indexes
    // Note: NCD/Bond issuers use _key as unique identifier (not issuer_code)
    const collection = appDb.collection('ncd_bond_issuers')
    
    const indexes = [
      {
        type: 'persistent',
        fields: ['is_active']
      }
    ]
    
    for (const index of indexes) {
      try {
        await collection.ensureIndex(index)
        console.log(`Index on ${index.fields.join(', ')} ensured`)
      } catch (error) {
        if (error.errorNum === 1207) {
          console.log(`Index on ${index.fields.join(', ')} already exists`)
        } else {
          console.warn(`Failed to create index on ${index.fields.join(', ')}:`, error.message)
        }
      }
    }
    
    console.log('NCD/Bond setup completed successfully!')
  } catch (error) {
    console.error('Error setting up NCD/Bonds:', error)
    process.exit(1)
  }
}

setupNCDBonds()

