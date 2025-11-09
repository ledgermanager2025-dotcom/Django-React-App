from django.contrib.auth.models import User
from rest_framework import serializers
from .models import StartingCapital, Material, Customer, Expense, Transaction



class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "password"]
        extra_kwargs = {"password": {"write_only": True}}

    def create(self, validated_data):
        print(validated_data)
        user = User.objects.create_user(**validated_data)
        return user

class LoginSerializer(serializers.Serializer):
    username = serializers.CharField(required=True)
    password = serializers.CharField(required=True, write_only=True)

class StartingCapitalSerializer(serializers.ModelSerializer):
    class Meta:
        model = StartingCapital
        fields = '__all__'

class MaterialSerializer(serializers.ModelSerializer):
    class Meta:
        model = Material
        fields = '__all__'

class CustomerSerializer(serializers.ModelSerializer):
    class Meta:
        model = Customer
        fields = '__all__'

class ExpenseSerializer(serializers.ModelSerializer):
    # Ensure date is outputted correctly
    date = serializers.DateField(format="%Y-%m-%d")
    class Meta:
        model = Expense
        fields = '__all__'


class TransactionSerializer(serializers.ModelSerializer):
    # Read-only fields to display names instead of IDs on GET requests
    material_name = serializers.CharField(source='material.name', read_only=True)
    customer_name = serializers.CharField(source='customer.name', read_only=True)
    
    class Meta:
        model = Transaction
        fields = '__all__'
        read_only_fields = ('timestamp',) # Automatically set by model

    # Custom validation to enforce required fields based on transaction type
    def validate(self, data):
        tx_type = data.get('transaction_type')
        
        # Validation for Credit (CR) / Purchase
        if tx_type == 'CR':
            if not data.get('material'):
                raise serializers.ValidationError({"material": "Material is required for a Purchase (CR)."})
            if not data.get('quantity'):
                raise serializers.ValidationError({"quantity": "Quantity is required for a Purchase (CR)."})
        
        # Validation for Debit (DB) / Sale
        elif tx_type == 'DB':
            if not data.get('material'):
                raise serializers.ValidationError({"material": "Material is required for a Sale (DB)."})
            if not data.get('customer'):
                raise serializers.ValidationError({"customer": "Customer is required for a Sale (DB)."})
            if not data.get('quantity'):
                raise serializers.ValidationError({"quantity": "Quantity is required for a Sale (DB)."})

        # Validation for Reconciliation (RC) / Customer Payment
        elif tx_type == 'RC':
            if not data.get('customer'):
                raise serializers.ValidationError({"customer": "Customer is required for a Reconciliation (RC)."})
            # The client-side will send the amount in 'total_price' or 'money_received' 
            # based on how we structure the form. For RC, we expect the received amount
            # to be present in 'total_price' or mapped to 'amount' if a separate model was used.
            # Sticking to the spec's Transaction model: use total_price for the paid amount.
            if 'total_price' not in data or data.get('total_price') is None:
                 raise serializers.ValidationError({"total_price": "Amount received is required for Reconciliation (RC)."})
            
        return data
