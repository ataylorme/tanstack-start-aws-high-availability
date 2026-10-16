import { describe, expect, it } from 'vitest'
import { flatUsdQuote, partialRecurringSubtotal } from '../experiments/celld/measurements/pricing.ts'
const fixture = () => ({ product:{sku:'fixture',attributes:{regionCode:'us-east-1'}},terms:{OnDemand:{term:{effectiveDate:'2026-01-01T00:00:00Z',priceDimensions:{dimension:{unit:'Hrs',beginRange:'0',endRange:'Inf',appliesTo:[],pricePerUnit:{USD:'0.0336'}}}}}}})
const select = (rows: unknown[]) => flatUsdQuote(rows,'Hrs',attributes=>attributes.regionCode==='us-east-1')
describe('flat USD pricing evidence', () => {
  it('extracts the matched quote and retains provenance', () => {
    expect(select([fixture()])).toEqual({usd:.0336,unit:'Hrs',sku:'fixture',effectiveDate:'2026-01-01T00:00:00Z'})
  })
  it('rejects missing and duplicate matches', () => {
    expect(()=>select([])).toThrow(); expect(()=>select([fixture(),fixture()])).toThrow()
  })
  it.each(['NaN','-1','Infinity','0.03 USD',''])('rejects malformed USD price %s', price => {
    const row=fixture();row.terms.OnDemand.term.priceDimensions.dimension.pricePerUnit.USD=price
    expect(()=>select([row])).toThrow()
  })
  it('rejects tiers and incompatible units instead of assuming zero or selecting a tier', () => {
    const row=fixture();row.terms.OnDemand.term.priceDimensions.dimension.endRange='100'
    expect(()=>select([row])).toThrow()
    row.terms.OnDemand.term.priceDimensions.dimension.endRange='Inf'
    row.terms.OnDemand.term.priceDimensions.dimension.unit='GB-Mo'
    expect(()=>select([row])).toThrow()
  })
  it('rejects scope-specific prices', () => {
    const row=fixture();row.terms.OnDemand.term.priceDimensions.dimension.appliesTo=['special'] as never[]
    expect(()=>select([row])).toThrow()
  })
  it('rejects quotes without a SKU or not yet effective', () => {
    const row=fixture();row.product.sku=''
    expect(()=>select([row])).toThrow()
    row.product.sku='fixture'
    expect(()=>flatUsdQuote([row],'Hrs',()=>true,Date.parse('2025-01-01'))).toThrow()
  })
  it('keeps monthly storage separate and applies the explicit 730-hour illustration', () => {
    expect(partialRecurringSubtotal([{partialRecurringUsdPerHour:.1,gp3UsdPerMonth:8},{partialRecurringUsdPerHour:.2,gp3UsdPerMonth:8}]).illustrative730HourMonthUsd).toBeCloseTo(235)
    expect(()=>partialRecurringSubtotal([])).toThrow()
    expect(()=>partialRecurringSubtotal([{partialRecurringUsdPerHour:NaN,gp3UsdPerMonth:8}])).toThrow()
  })
})
