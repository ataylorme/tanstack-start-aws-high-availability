import {expect,it} from 'vitest'
import {marginalUsdCost,usdSchedule,sumUsdCosts} from '../experiments/celld/measurements/pricing.ts'
const fixture=()=>({product:{sku:'fixture',attributes:{regionCode:'us-east-1'}},terms:{OnDemand:{term:{effectiveDate:'2026-01-01',priceDimensions:{
  second:{unit:'GB-Mo',beginRange:'25',endRange:'Inf',appliesTo:[],pricePerUnit:{USD:'0.25'}},
  first:{unit:'GB-Mo',beginRange:'0',endRange:'25',appliesTo:[],pricePerUnit:{USD:'0'}},
}}}}})
const parse=(value:unknown=fixture())=>usdSchedule([value],'GB-Mo',()=>true)
it('sorts full tiers and preserves provenance',()=> {
  expect(parse()).toEqual({unit:'GB-Mo',sku:'fixture',effectiveDate:'2026-01-01',tiers:[{from:0,to:25,usd:0},{from:25,to:null,usd:.25}]})
})
it('requires explicit already-used capacity rather than assigning account free tiers to this lab',()=> {
  expect(marginalUsdCost(parse(),20,0)).toBe(0)
  expect(marginalUsdCost(parse(),20,25)).toBe(5)
  expect(marginalUsdCost(parse(),20,20)).toBe(3.75)
  expect(marginalUsdCost(parse(),0,20)).toBe(0)
})
it('rejects missing, duplicate and future price products',()=> {
  expect(()=>usdSchedule([],'GB-Mo',()=>true)).toThrow()
  expect(()=>usdSchedule([fixture(),fixture()],'GB-Mo',()=>true)).toThrow()
  expect(()=>usdSchedule([fixture()],'GB-Mo',()=>true,0)).toThrow()
})
it('rejects gaps, overlaps, finite tails and invalid intervals',()=> {
  for(const change of [26,24]) {const value=fixture();value.terms.OnDemand.term.priceDimensions.second.beginRange=String(change);expect(()=>parse(value)).toThrow()}
  const value=fixture();value.terms.OnDemand.term.priceDimensions.second.endRange='30';expect(()=>parse(value)).toThrow()
  value.terms.OnDemand.term.priceDimensions.second.endRange='25';expect(()=>parse(value)).toThrow()
})
it('rejects scope-specific or incompatible price dimensions',()=> {
  const value=fixture();value.terms.OnDemand.term.priceDimensions.first.unit='GB';expect(()=>parse(value)).toThrow()
  value.terms.OnDemand.term.priceDimensions.first.unit='GB-Mo';value.terms.OnDemand.term.priceDimensions.first.appliesTo=['special'] as never[];expect(()=>parse(value)).toThrow()
})
it.each(['-1','NaN','Infinity','0.2 USD',''])('rejects malformed price %s',usd=> {
  const value=fixture();value.terms.OnDemand.term.priceDimensions.second.pricePerUnit.USD=usd;expect(()=>parse(value)).toThrow()
})
it('uses the catalog per-unit rate directly, not a second per-million divisor',()=> {
  const value=fixture();value.terms.OnDemand.term.priceDimensions.first.endRange='Inf';delete (value.terms.OnDemand.term.priceDimensions as any).second
  value.terms.OnDemand.term.priceDimensions.first.pricePerUnit.USD='0.000001'
  expect(marginalUsdCost(parse(value),1_000_000,0)).toBe(1)
})
it('rejects invalid usage and arithmetic overflow',()=> {
  for(const quantity of [-1,NaN,Infinity]) expect(()=>marginalUsdCost(parse(),quantity,0)).toThrow()
  expect(()=>marginalUsdCost(parse(),1,-1)).toThrow()
  expect(()=>marginalUsdCost(parse(),Number.MAX_VALUE,Number.MAX_VALUE)).toThrow()
})

it('rejects aggregate overflow rather than serializing an infinite total as null',()=> {
  expect(()=>sumUsdCosts([Number.MAX_VALUE*.75,Number.MAX_VALUE*.75])).toThrow()
  expect(sumUsdCosts([.25,.5])).toBe(.75)
  expect(()=>sumUsdCosts([])).toThrow()
})
it('rejects invalid pricing context and precision-lost usage',()=> {
  expect(()=>usdSchedule([fixture()],'GB-Mo',()=>true,NaN)).toThrow()
  expect(()=>usdSchedule([fixture()],'',()=>true)).toThrow()
  expect(()=>marginalUsdCost(parse(),1,Number.MAX_VALUE)).toThrow()
})
