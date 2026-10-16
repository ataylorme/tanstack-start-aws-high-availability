/** Require a single flat On-Demand USD dimension; never silently select a tier. */
export function flatUsdQuote(products: unknown[], unit: string, matches: (attributes: Record<string, string>) => boolean, now = Date.now()) {
  const selected = products.filter((value: any) => value?.product?.attributes && matches(value.product.attributes)) as any[]
  if (selected.length !== 1) throw new Error('Expected exactly one matching price product')
  const product = selected[0]
  const terms = Object.values(product.terms?.OnDemand ?? {}) as any[]
  if (terms.length !== 1) throw new Error('Expected one On-Demand term')
  const dimensions = Object.values(terms[0].priceDimensions ?? {}) as any[]
  if (dimensions.length !== 1) throw new Error('Tiered or ambiguous pricing needs explicit modeling')
  const dimension = dimensions[0], dollars = dimension.pricePerUnit?.USD
  if (dimension.unit !== unit || dimension.beginRange !== '0' || dimension.endRange !== 'Inf'
    || !Array.isArray(dimension.appliesTo) || dimension.appliesTo.length !== 0
    || typeof dollars !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(dollars)
    || !Number.isFinite(Number(dollars)) || typeof product.product.sku !== 'string' || !product.product.sku
    || !Number.isFinite(Date.parse(terms[0].effectiveDate)) || Date.parse(terms[0].effectiveDate) > now) throw new Error('Unsupported or invalid flat USD quote')
  return { usd: Number(dollars), unit, sku: product.product.sku, effectiveDate: terms[0].effectiveDate as string }
}

export function partialRecurringSubtotal(rows: readonly { partialRecurringUsdPerHour: number; gp3UsdPerMonth: number }[]) {
  if (!rows.length || rows.some(row => [row.partialRecurringUsdPerHour, row.gp3UsdPerMonth].some(value => !Number.isFinite(value) || value < 0))) throw new Error('Invalid recurring cost quantities')
  const hourly = rows.reduce((sum, row) => sum + row.partialRecurringUsdPerHour, 0)
  const monthlyStorage = rows.reduce((sum, row) => sum + row.gp3UsdPerMonth, 0)
  return { partialRecurringUsdPerHour: hourly, gp3UsdPerMonth: monthlyStorage, illustrative730HourMonthUsd: hourly * 730 + monthlyStorage }
}

export interface UsdSchedule {
  unit: string; sku: string; effectiveDate: string
  tiers: {from:number;to:number|null;usd:number;description?:string}[]
}
/** Keep the complete contiguous schedule; account-wide tiers are not lab allowances. */
export function usdSchedule(products: unknown[],unit:string,matches:(attributes:Record<string,string>)=>boolean,now=Date.now()):UsdSchedule {
  if(!unit || !Number.isFinite(now) || now<0) throw new Error('Invalid pricing context')
  const selected=products.filter((value:any)=>value?.product?.attributes && matches(value.product.attributes)) as any[]
  if(selected.length!==1) throw new Error('Expected exactly one matching price product')
  const product=selected[0],terms=Object.values(product.terms?.OnDemand??{}) as any[]
  if(terms.length!==1 || typeof terms[0].effectiveDate!=='string' || typeof product.product.sku!=='string' || !product.product.sku || !Number.isFinite(Date.parse(terms[0].effectiveDate)) || Date.parse(terms[0].effectiveDate)>now) throw new Error('Invalid On-Demand provenance')
  const number=(value:unknown)=> {
    if(typeof value!=='string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error('Invalid price number')
    return Number(value)
  }
  const dimensions=Object.values(terms[0].priceDimensions??{}) as any[]
  if(!dimensions.length || dimensions.length>1000) throw new Error('Invalid price dimensions')
  const tiers=dimensions.map(value=> {
    if(value.unit!==unit || !Array.isArray(value.appliesTo) || value.appliesTo.length) throw new Error('Incompatible price dimension')
    const from=number(value.beginRange),to=value.endRange==='Inf'?null:number(value.endRange),usd=number(value.pricePerUnit?.USD)
    if(to!==null && to<=from) throw new Error('Invalid price interval')
    return {from,to,usd,...(typeof value.description==='string'?{description:value.description}:{})}
  }).sort((a,b)=>a.from-b.from)
  if(tiers[0]!.from!==0 || tiers.at(-1)!.to!==null || tiers.slice(1).some((tier,index)=>tiers[index]!.to!==tier.from)) throw new Error('Price schedule must cover zero to infinity without gaps/overlap')
  return {unit,sku:product.product.sku,effectiveDate:terms[0].effectiveDate,tiers}
}
/** Marginal list-price scenario, not allocation of discounts or actual billing. */
export function marginalUsdCost(schedule:UsdSchedule,quantity:number,existingUsage:number) {
  if([quantity,existingUsage].some(value=>!Number.isFinite(value)||value<0) || !Number.isFinite(quantity+existingUsage)) throw new Error('Invalid modeled usage')
  const end=existingUsage+quantity
  if(quantity>0 && end<=existingUsage) throw new Error('Usage precision lost')
  const usd=schedule.tiers.reduce((sum,tier)=>sum+Math.max(0,Math.min(end,tier.to??Infinity)-Math.max(existingUsage,tier.from))*tier.usd,0)
  if(!Number.isFinite(usd)) throw new Error('Modeled price overflow')
  return usd
}

export function sumUsdCosts(costs:readonly number[]) {
  if(!costs.length || costs.some(value=>!Number.isFinite(value)||value<0)) throw new Error('Invalid modeled cost rows')
  const total=costs.reduce((sum,value)=>sum+value,0)
  if(!Number.isFinite(total)) throw new Error('Modeled total overflow')
  return total
}
