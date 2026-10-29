import ServiceRequest from '../models/ServiceRequest.js';
export async function assertServiceSettlementReady(order,session){
 if(order.type!=='service')return;
 const query=ServiceRequest.findOne({paymentOrder:order._id,buyer:order.buyer,provider:order.seller,status:'completed'});
 if(session)query.session(session);
 if(!await query)throw new Error('Service completion has not been confirmed by the buyer or is disputed.');
}
