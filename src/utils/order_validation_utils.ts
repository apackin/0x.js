import * as _ from 'lodash';
import {ExchangeContractErrs, SignedOrder, Order, ZeroExError, TradeSide, TransferType} from '../types';
import {ZeroEx} from '../0x';
import {TokenWrapper} from '../contract_wrappers/token_wrapper';
import {ExchangeWrapper} from '../contract_wrappers/exchange_wrapper';
import {utils} from '../utils/utils';
import {constants} from '../utils/constants';
import {ExchangeTransferSimulator} from './exchange_transfer_simulator';

export class OrderValidationUtils {
    private tokenWrapper: TokenWrapper;
    private exchangeWrapper: ExchangeWrapper;
    constructor(tokenWrapper: TokenWrapper, exchangeWrapper: ExchangeWrapper) {
        this.tokenWrapper = tokenWrapper;
        this.exchangeWrapper = exchangeWrapper;
    }
    public async validateOrderFillableOrThrowAsync(
        exchangeTradeEmulator: ExchangeTransferSimulator, signedOrder: SignedOrder, zrxTokenAddress: string,
        expectedFillTakerTokenAmount?: BigNumber.BigNumber): Promise<void> {
        const orderHash = utils.getOrderHashHex(signedOrder);
        const unavailableTakerTokenAmount = await this.exchangeWrapper.getUnavailableTakerAmountAsync(orderHash);
        this.validateRemainingFillAmountNotZeroOrThrow(
            signedOrder.takerTokenAmount, unavailableTakerTokenAmount,
        );
        this.validateOrderNotExpiredOrThrow(signedOrder.expirationUnixTimestampSec);
        let fillTakerTokenAmount = signedOrder.takerTokenAmount.minus(unavailableTakerTokenAmount);
        if (!_.isUndefined(expectedFillTakerTokenAmount)) {
            fillTakerTokenAmount = expectedFillTakerTokenAmount;
        }
        const fillMakerTokenAmount = this.getFillMakerTokenAmount(signedOrder, fillTakerTokenAmount);
        await exchangeTradeEmulator.transferFromAsync(
            signedOrder.makerTokenAddress, signedOrder.maker, signedOrder.taker, fillMakerTokenAmount,
            TradeSide.Maker, TransferType.Trade,
        );
        await exchangeTradeEmulator.transferFromAsync(
            zrxTokenAddress, signedOrder.maker, signedOrder.feeRecipient, signedOrder.makerFee,
            TradeSide.Maker, TransferType.Fee,
        );
    }
    public async validateFillOrderThrowIfInvalidAsync(
        exchangeTradeEmulator: ExchangeTransferSimulator, signedOrder: SignedOrder,
        fillTakerTokenAmount: BigNumber.BigNumber, takerAddress: string,
        zrxTokenAddress: string): Promise<BigNumber.BigNumber> {
        if (fillTakerTokenAmount.eq(0)) {
            throw new Error(ExchangeContractErrs.OrderFillAmountZero);
        }
        const orderHash = utils.getOrderHashHex(signedOrder);
        if (!ZeroEx.isValidSignature(orderHash, signedOrder.ecSignature, signedOrder.maker)) {
            throw new Error(ZeroExError.InvalidSignature);
        }
        const unavailableTakerTokenAmount = await this.exchangeWrapper.getUnavailableTakerAmountAsync(orderHash);
        this.validateRemainingFillAmountNotZeroOrThrow(
            signedOrder.takerTokenAmount, unavailableTakerTokenAmount,
        );
        if (signedOrder.taker !== constants.NULL_ADDRESS && signedOrder.taker !== takerAddress) {
            throw new Error(ExchangeContractErrs.TransactionSenderIsNotFillOrderTaker);
        }
        this.validateOrderNotExpiredOrThrow(signedOrder.expirationUnixTimestampSec);
        const remainingTakerTokenAmount = signedOrder.takerTokenAmount.minus(unavailableTakerTokenAmount);
        const filledTakerTokenAmount = remainingTakerTokenAmount.lessThan(fillTakerTokenAmount) ?
                                       remainingTakerTokenAmount :
                                       fillTakerTokenAmount;
        await this.validateFillOrderBalancesAllowancesThrowIfInvalidAsync(
            exchangeTradeEmulator, signedOrder, filledTakerTokenAmount, takerAddress, zrxTokenAddress,
        );

        const wouldRoundingErrorOccur = await this.exchangeWrapper.isRoundingErrorAsync(
            filledTakerTokenAmount, signedOrder.takerTokenAmount, signedOrder.makerTokenAmount,
        );
        if (wouldRoundingErrorOccur) {
            throw new Error(ExchangeContractErrs.OrderFillRoundingError);
        }
        return filledTakerTokenAmount;
    }
    public async validateFillOrKillOrderThrowIfInvalidAsync(
        exchangeTradeEmulator: ExchangeTransferSimulator, signedOrder: SignedOrder,
        fillTakerTokenAmount: BigNumber.BigNumber, takerAddress: string, zrxTokenAddress: string): Promise<void> {
        const filledTakerTokenAmount = await this.validateFillOrderThrowIfInvalidAsync(
            exchangeTradeEmulator, signedOrder, fillTakerTokenAmount, takerAddress, zrxTokenAddress,
        );
        if (filledTakerTokenAmount !== fillTakerTokenAmount) {
            throw new Error(ExchangeContractErrs.InsufficientRemainingFillAmount);
        }
    }
    public async validateCancelOrderThrowIfInvalidAsync(order: Order,
                                                        cancelTakerTokenAmount: BigNumber.BigNumber,
                                                        unavailableTakerTokenAmount: BigNumber.BigNumber,
    ): Promise<void> {
        if (cancelTakerTokenAmount.eq(0)) {
            throw new Error(ExchangeContractErrs.OrderCancelAmountZero);
        }
        if (order.takerTokenAmount.eq(unavailableTakerTokenAmount)) {
            throw new Error(ExchangeContractErrs.OrderAlreadyCancelledOrFilled);
        }
        const currentUnixTimestampSec = utils.getCurrentUnixTimestamp();
        if (order.expirationUnixTimestampSec.lessThan(currentUnixTimestampSec)) {
            throw new Error(ExchangeContractErrs.OrderCancelExpired);
        }
    }
    public async validateFillOrderBalancesAllowancesThrowIfInvalidAsync(
        exchangeTradeEmulator: ExchangeTransferSimulator, signedOrder: SignedOrder,
        fillTakerTokenAmount: BigNumber.BigNumber, senderAddress: string, zrxTokenAddress: string): Promise<void> {
        const fillMakerTokenAmount = this.getFillMakerTokenAmount(signedOrder, fillTakerTokenAmount);
        await exchangeTradeEmulator.transferFromAsync(
            signedOrder.makerTokenAddress, signedOrder.maker, signedOrder.taker, fillMakerTokenAmount,
            TradeSide.Maker, TransferType.Trade,
        );
        await exchangeTradeEmulator.transferFromAsync(
            signedOrder.takerTokenAddress, signedOrder.taker, signedOrder.maker, fillTakerTokenAmount,
            TradeSide.Taker, TransferType.Trade,
        );
        await exchangeTradeEmulator.transferFromAsync(
            zrxTokenAddress, signedOrder.maker, signedOrder.feeRecipient, signedOrder.makerFee, TradeSide.Maker,
            TransferType.Fee,
        );
        await exchangeTradeEmulator.transferFromAsync(
            zrxTokenAddress, signedOrder.taker, signedOrder.feeRecipient, signedOrder.takerFee, TradeSide.Taker,
            TransferType.Fee,
        );
    }
    private validateRemainingFillAmountNotZeroOrThrow(
        takerTokenAmount: BigNumber.BigNumber, unavailableTakerTokenAmount: BigNumber.BigNumber,
    ) {
        if (takerTokenAmount.eq(unavailableTakerTokenAmount)) {
            throw new Error(ExchangeContractErrs.OrderRemainingFillAmountZero);
        }
    }
    private validateOrderNotExpiredOrThrow(expirationUnixTimestampSec: BigNumber.BigNumber) {
        const currentUnixTimestampSec = utils.getCurrentUnixTimestamp();
        if (expirationUnixTimestampSec.lessThan(currentUnixTimestampSec)) {
            throw new Error(ExchangeContractErrs.OrderFillExpired);
        }
    }
    private getFillMakerTokenAmount(signedOrder: Order,
                                    fillTakerTokenAmount: BigNumber.BigNumber): BigNumber.BigNumber {
        const exchangeRate = signedOrder.takerTokenAmount.div(signedOrder.makerTokenAmount);
        const fillMakerTokenAmount = fillTakerTokenAmount.div(exchangeRate);
        return fillMakerTokenAmount;
    }
}
