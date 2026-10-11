'use strict';
// Caller holds the affected product locks before changing options. No catalog
// submission locks are acquired here, preserving the existing lock order.
async function syncVariantTotals(client,productIds){
 for(const id of [...new Set(productIds.map(String))].sort()){
  const rows=await client.query(`UPDATE public.cerood_shop_products p SET stock=(
   SELECT COALESCE(sum(v.stock),0) FROM public.cerood_product_variants v
   WHERE v.marketplace='general' AND v.product_id=p.id::text AND v.is_active=true
  ),updated_at=now() WHERE p.id=$1 RETURNING p.id`,[id]);
  if(rows.length!==1)throw Object.assign(Error('Product inventory total could not be updated. Transaction rolled back.'),{status:409});
 }
}
module.exports={syncVariantTotals};
