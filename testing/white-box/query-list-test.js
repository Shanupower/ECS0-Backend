import assert from 'node:assert/strict'

import {
  parseQueryList,
  parseBranchCodes,
  parseEmpCodes,
  parseProductCategories,
  parseSchemeCategories,
  parseInvestorIds
} from '../../utils/query-list.js'
import { applyReceiptCategoryFilters } from '../../utils/receipt-filters.js'

assert.deepEqual(parseQueryList({ branch_codes: 'A,B' }, 'branch_codes'), ['A', 'B'])
assert.deepEqual(parseQueryList({ branch_code: 'X' }, 'branch_codes', 'branch_code'), ['X'])
assert.deepEqual(parseBranchCodes({ branch_codes: 'BR1,BR2', branch_code: 'BR3' }), ['BR1', 'BR2', 'BR3'])
assert.deepEqual(parseEmpCodes({ emp_code: 'E1' }), ['E1'])
assert.deepEqual(parseProductCategories({ category: 'MF', product_categories: 'FD' }).sort(), ['FD', 'MF'])
assert.deepEqual(parseSchemeCategories({ scheme_categories: 'Equity,Debt' }), ['Equity', 'Debt'])
assert.deepEqual(parseInvestorIds({ investor_ids: '101,102' }), ['101', '102'])

const filterConditions = []
const bindVars = {}
applyReceiptCategoryFilters(filterConditions, bindVars, ['MF', 'FD'])
assert.equal(filterConditions.length, 1)
assert.match(filterConditions[0], / OR /)

const insConditions = []
const insBind = {}
applyReceiptCategoryFilters(insConditions, insBind, ['INS'])
assert.equal(insConditions.length, 1)
assert.match(insConditions[0], /ins_category_aliases/)
assert.match(insConditions[0], /product_details\.insurance/)

console.log('[White Box] query-list tests passed')
